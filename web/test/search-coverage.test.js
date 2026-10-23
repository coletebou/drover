// What the index covers beyond conversation (2026-10-20): command lines (keyword-only), documents (Codex memories,
// dotfiles specs and docs, split at headings), the identity filter for memory homes and documents, per-host source
// kinds, the one-time re-read when the extractor changes, and the fleet coverage report.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const STATE = await mkdtemp(path.join(tmpdir(), 'drover-search-cov-'));
process.env.DROVER_STATE = STATE;   // before api.js reads it
const { claudeLine, codexLine, claudeToolLine, codexToolLines, markdownSections, docSections, COMMAND_CHARS } = await import('../core/search/extract.js');
const { Store, KEYWORD_ONLY } = await import('../core/search/store.js');
const { Indexer, EXTRACT_VERSION, docPatterns, homeInIdentity, searchKinds } = await import('../core/search/indexer.js');
const { search } = await import('../core/search/query.js');
const { truncateNormalize } = await import('../core/search/vec.js');
const { fleetCoverage } = await import('../core/api.js');
const plugins = await import('../core/plugins.js');

const j = (o) => JSON.stringify(o) + '\n';
// A made-up token in the shape of a forge's personal access token, assembled at runtime so no credential-looking
// literal is in the source.
const FAKE_BODY = 'a1b2c3d4e5'.repeat(4);
const FAKE_PAT = ['webapp', 'pat', FAKE_BODY].join('_');
function bagVec(text) {
  const v = new Float32Array(768);
  for (const w of String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []) { let h = 7; for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0; v[h % 256] += 1; }
  return v;
}
const fakeEmbedder = () => ({ batch: 8, inputs: 0, installed: () => true, async embed(texts) { this.inputs += texts.length; return texts.map((t) => truncateNormalize(bagVec(t))); } });

after(async () => { await rm(STATE, { recursive: true, force: true }); });

describe('command lines', () => {
  test('Claude tool calls: commands with their purpose, written and edited paths, fetches and searches; reads give nothing', () => {
    assert.equal(claudeToolLine('Bash', { command: 'npm i -g turbo@1.13.4', description: 'Install Turbo globally' }), '$ npm i -g turbo@1.13.4  # Install Turbo globally');
    assert.equal(claudeToolLine('Write', { file_path: '/home/u/code/webapp/turbo.json', content: '{"pipeline":{}}' }), 'wrote /home/u/code/webapp/turbo.json');
    assert.equal(claudeToolLine('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }), 'edited a.ts');
    assert.equal(claudeToolLine('WebFetch', { url: 'https://turbo.build/repo/docs' }), 'fetched https://turbo.build/repo/docs');
    assert.equal(claudeToolLine('WebSearch', { query: 'tsgo native preview' }), 'searched the web: tsgo native preview');
    for (const [n, i] of [['Read', { file_path: 'x' }], ['Grep', { pattern: 'x' }], ['Agent', { prompt: 'x' }], ['Bash', {}], ['Bash', null]]) assert.equal(claudeToolLine(n, i), '');
  });
  test('a command is cut short (a heredoc body never lands whole) and its secrets are redacted', () => {
    const long = claudeToolLine('Bash', { command: `cat <<'EOF' > x.py\n${'print(1)\n'.repeat(200)}EOF` });
    assert.ok(long.length <= COMMAND_CHARS + 2 && long.endsWith('…'));
    assert.match(claudeToolLine('Bash', { command: `git remote set-url origin https://alice:${FAKE_PAT}@forge.example/repos/webapp/git` }), /alice:\[redacted\]@forge\.example/);
    assert.doesNotMatch(claudeToolLine('Bash', { command: 'curl -H "Authorization: Bearer abcDEF123456789ghiJKL" https://x' }), /abcDEF123456789/);
  });
  test('Codex tool calls: exec_command, shell argv, apply_patch files, code-mode cmd literals; messaging gives nothing', () => {
    assert.deepEqual(codexToolLines({ type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'turbo run typecheck', max_output_tokens: 10 }) }), ['$ turbo run typecheck']);
    assert.deepEqual(codexToolLines({ type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'npx tsgo --noEmit'] }) }), ['$ npx tsgo --noEmit']);
    assert.deepEqual(codexToolLines({ type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: turbo.json\n+{}\n*** Update File: package.json\n*** Delete File: old.ts\n*** End Patch' }), ['wrote turbo.json', 'edited package.json', 'deleted old.ts']);
    assert.deepEqual(codexToolLines({ type: 'custom_tool_call', name: 'exec', input: 'const r = await tools.exec_command({cmd:"rg -n \\"tsgo\\" docs", max_output_tokens: 100}); text(r);' }), ['$ rg -n "tsgo" docs']);
    for (const p of [{ type: 'local_shell_call', action: { command: [''] } }, { type: 'function_call', name: 'send_message', arguments: '{"message":"pv_x"}' }, { type: 'function_call', name: 'sleep', arguments: '{"duration_ms":10}' }, { type: 'function_call', name: 'exec_command', arguments: 'not json' }, { type: 'custom_tool_call', name: 'exec', input: 'text(1)' }]) assert.deepEqual(codexToolLines(p), []);
  });
  test('transcript lines carry the commands as their own units; tool output stays out', () => {
    const a = claudeLine(j({ type: 'assistant', message: { content: [{ type: 'text', text: 'Installing it.' }, { type: 'tool_use', name: 'Bash', input: { command: 'turbo --version' } }] } }));
    assert.deepEqual(a.units, [{ role: 'assistant', text: 'Installing it.' }, { role: 'command', text: '$ turbo --version' }]);
    assert.deepEqual(claudeLine(j({ type: 'user', message: { content: [{ type: 'tool_result', content: '1.13.4' }] } })).units, []);
    const c = codexLine(j({ type: 'response_item', timestamp: 't', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'tsgo -b' }) } }));
    assert.deepEqual(c.units, [{ role: 'command', text: '$ tsgo -b' }]);
    assert.deepEqual(codexLine(j({ type: 'response_item', payload: { type: 'function_call_output', output: 'done' } })).units, []);
  });
});

describe('documents', () => {
  test('markdown sections cut at # and ## outside code fences; text before the first heading is its own section', () => {
    const s = markdownSections('intro\n# A\nalpha\n```\n# not a heading\n```\n## B\nbeta\n### c stays inside B\n# Empty\n');
    assert.deepEqual(s.map((x) => [x.level, x.heading]), [[0, ''], [1, 'A'], [2, 'B']]);
    assert.match(s[1].body, /# not a heading/); assert.match(s[2].body, /### c stays inside B/);
  });
  test('Codex memory: label, task group and task in the title; the group\'s cwd is every section\'s project', () => {
    const d = docSections('# Task Group: Webapp build tooling\n\napplies_to: cwd=/Users/x/code/webapp; reuse_rule=...\n\n## Task 2: Explain what the TypeScript native Go port would speed up\n\nTypeScript 7 speeds up typecheck', 'MEMORY.md', { label: 'Codex memory (box-a)' });
    assert.deepEqual(d.sections.map((x) => x.title), ['Codex memory (box-a) › Task Group: Webapp build tooling', 'Codex memory (box-a) › Task Group: Webapp build tooling › Task 2: Explain what the TypeScript native Go port would speed up']);
    assert.ok(d.sections.every((x) => x.project === 'webapp'));
  });
  test('a rollout summary gives its thread id, time and repo; a spec keeps its frontmatter title', () => {
    const r = docSections('thread_id: 019f6676-9ea7-71e1-83d3-e5ea8fc80114\nupdated_at: 2026-07-16T18:19:08+00:00\ncwd: /Users/x/code/webapp\n\n# Webapp build tooling mapping\n\n## Task 1: Map Rolldown\n\nbody', 'r.md');
    assert.equal(r.sessionId, '019f6676-9ea7-71e1-83d3-e5ea8fc80114'); assert.equal(r.ts, '2026-07-16T18:19:08+00:00');
    assert.equal(r.sections.at(-1).title, 'Webapp build tooling mapping › Task 1: Map Rolldown'); assert.equal(r.sections.at(-1).project, 'webapp');
    const spec = docSections('---\nname: pnpm-migration\ndescription: arguments\n---\n\n## Why\n\nfaster installs', 'p.md');
    assert.equal(spec.sections[0].title, 'pnpm-migration: arguments › Why');
    assert.equal(docSections('---\ndescription: no name here\n---\n\n# Real title\n\nbody', 'f.md').sections[0].title, 'Real title', 'frontmatter without a name: the first # heading');
  });
  test('an empty # heading still encloses the ## sections after it; a host label is never redacted', () => {
    const d = docSections('# Task Group: A\n\napplies_to: cwd=/x/code/webapp\n\n## Task 1\n\none\n\n# Task Group: B\n\n## Task 2\n\ntwo', 'MEMORY.md', { label: 'Codex memory (box-019f741534bc72c9922a33e766cfdc69)' });
    const two = d.sections.find((x) => x.text === 'two');
    assert.equal(two.title, 'Codex memory (box-019f741534bc72c9922a33e766cfdc69) › Task Group: B › Task 2');
    assert.equal(two.project, null, 'Task 2 is under B, which names no directory, not under A');
  });
  test('doc patterns: placeholders resolve, identity-only patterns drop while it is unknown, the env replaces or turns them off', () => {
    const env = { HOME: '/h', CODEX_HOME: '/c' };
    const work = docPatterns(env, 'work');
    assert.ok(work.includes('/c/memories/MEMORY.md') && work.includes('/h/.dotfiles/identities/work/*.md'));
    assert.ok(!docPatterns(env, null).some((p) => p.includes('identities')));
    assert.deepEqual(docPatterns({ ...env, DROVER_SEARCH_DOCS: '~/notes/*.md|{dotfiles}/x.md' }, 'work'), ['/h/notes/*.md', '/h/.dotfiles/x.md']);
    assert.deepEqual(docPatterns({ ...env, DROVER_SEARCH_DOCS: 'off' }, 'work'), []);
    assert.equal(homeInIdentity('/h/.dotfiles/identities/personal/claude/memory/billing', { dotfiles: '/h/.dotfiles', identity: 'work' }), false);
    assert.equal(homeInIdentity('/h/.dotfiles/identities/work/claude/memory/webapp', { dotfiles: '/h/.dotfiles', identity: 'work' }), true);
    assert.equal(homeInIdentity('/elsewhere/memory', { dotfiles: '/h/.dotfiles', identity: 'work' }), true);
    assert.deepEqual([...searchKinds({ DROVER_SEARCH_KINDS: 'claude, subagent,bogus' })], ['claude', 'subagent']);
  });
});

describe('indexing what agents did, documents, scope', () => {
  let dir, roots, store, emb, dot, codexHome, homes;
  const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const file = () => path.join(roots.claude, '-home-u-code-webapp', `${SID}.jsonl`);
  const make = (o = {}) => new Indexer({ store, embedder: emb, roots, memoryHomes: async () => homes, identity: 'work', env: { HOME: dir, CODEX_HOME: codexHome, DROVER_DOTFILES: dot }, ...o });
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'drover-search-cov-idx-'));
    dot = path.join(dir, 'dotfiles'); codexHome = path.join(dir, 'codex');
    roots = { claude: path.join(dir, 'projects'), codex: path.join(dir, 'sessions'), wal: path.join(dir, 'events.jsonl') };
    roots.docs = [`${codexHome}/memories/MEMORY.md`, `${dot}/identities/work/codex/snapshots/*/MEMORY.md`, `${dot}/identities/work/*.md`, `${dot}/specs/*.md`];
    await mkdir(path.join(roots.claude, '-home-u-code-webapp'), { recursive: true });
    await writeFile(file(), [
      j({ type: 'user', timestamp: '2026-04-30T21:31:00Z', uuid: 'u1', cwd: '/home/u/code/webapp', sessionId: SID, message: { content: 'how much time would we save on builds if we switched pnpm' } }),
      j({ type: 'assistant', timestamp: '2026-04-30T21:49:00Z', uuid: 'a1', message: { content: [{ type: 'text', text: 'Setting up Turborepo locally.' }] } }),
      j({ type: 'assistant', timestamp: '2026-04-30T21:49:54Z', uuid: 'a2', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/home/u/code/webapp/turbo.json', content: '{}' } }] } }),
      j({ type: 'user', timestamp: '2026-04-30T21:49:55Z', message: { content: [{ type: 'tool_result', content: 'File created' }] } }),
      j({ type: 'assistant', timestamp: '2026-04-30T21:56:06Z', uuid: 'a3', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm i -g turbo@1.13.4 && turbo --version', description: 'Install Turbo 1.x globally' } }] } }),
      j({ type: 'assistant', timestamp: '2026-04-30T22:03:00Z', uuid: 'a4', message: { content: [{ type: 'text', text: 'Warm build of shared: 153 ms.' }] } }),
    ].join(''));
    await mkdir(path.join(codexHome, 'memories'), { recursive: true });
    await writeFile(path.join(codexHome, 'memories', 'MEMORY.md'), '# Task Group: Local notes\n\napplies_to: cwd=/home/u/code/drover\n\n## Task 1: Search index\n\nKeep the index local.\n');
    await mkdir(path.join(dot, 'identities', 'work', 'codex', 'snapshots', 'box-a'), { recursive: true });
    await writeFile(path.join(dot, 'identities', 'work', 'codex', 'snapshots', 'box-a', 'MEMORY.md'), '# Task Group: Webapp build tooling and TypeScript compiler impact\n\napplies_to: cwd=/Users/c/code/webapp\n\n## Task 2: Explain what the TypeScript native Go port would speed up in Webapp\n\nTypeScript 7 or the native Go port would mainly speed up type-checking and editor responsiveness.\n');
    await writeFile(path.join(dot, 'identities', 'work', 'webapp-onboarding-observations.md'), '# Webapp onboarding observations\n\n## Build tooling\n\nnot pnpm or turbo/nx/moon; Turbo or Nx would add remote caching.\n');
    await mkdir(path.join(dot, 'identities', 'personal'), { recursive: true });
    await writeFile(path.join(dot, 'identities', 'personal', 'secret-plans.md'), '# Personal\n\nzebra holiday plans\n');
    await mkdir(path.join(dot, 'specs'), { recursive: true });
    await writeFile(path.join(dot, 'specs', '2026-05-20-pnpm-migration-arguments.md'), '# pnpm migration arguments\n\n## Verdict\n\nMigrate after the bench.\n');
    const workMem = path.join(dot, 'identities', 'work', 'claude', 'memory', 'webapp');
    const persMem = path.join(dot, 'identities', 'personal', 'claude', 'memory', 'billing');
    await mkdir(workMem, { recursive: true }); await mkdir(persMem, { recursive: true });
    await writeFile(path.join(workMem, 'note.md'), 'typecheck heap is 12 GB');
    await writeFile(path.join(persMem, 'note.md'), 'tsgo core gate for openclaw walrus');
    homes = { webapp: workMem, Billing: persMem };
    store = new Store(path.join(dir, 'search.sqlite'));
    emb = fakeEmbedder();
  });
  after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });

  test('commands are one keyword-only chunk per run of tool calls: found by their words, never embedded', async () => {
    await make().tick();
    const cmds = store.db.prepare("SELECT text, ts, session_id, project FROM chunks WHERE role = 'command'").all();
    assert.equal(cmds.length, 1, 'the Write and the Bash call (a tool result between them) are one run');
    assert.match(cmds[0].text, /^wrote \/home\/u\/code\/webapp\/turbo\.json\n\$ npm i -g turbo@1\.13\.4 && turbo --version {2}# Install Turbo 1\.x globally$/);
    assert.equal(cmds[0].session_id, SID); assert.equal(cmds[0].project, 'webapp'); assert.equal(cmds[0].ts, '2026-04-30T21:49:54Z');
    assert.deepEqual(KEYWORD_ONLY, ['command']);
    assert.equal(store.pendingCount(), 0, 'every other chunk has a vector, and commands are not pending');
    assert.equal(store.stats().keywordOnly, 1);
    const kw = await search(store, null, { query: 'turbo@1.13.4', mode: 'keyword' });
    assert.ok(kw.results.some((r) => r.role === 'command' && r.sessionId === SID), 'a keyword search finds the command');
    const only = await search(store, null, { query: 'turbo', mode: 'keyword', role: 'command' });
    assert.equal(only.results.length, 1); assert.match(only.results[0].snippet, /npm i -g turbo@1\.13\.4/);
    const sem = await search(store, { embed: (t) => emb.embed(t) }, { query: 'npm i -g turbo', mode: 'semantic', limit: 50 });
    assert.ok(!sem.results.some((r) => r.role === 'command'), 'the vector leg never returns a command chunk');
  });
  test('documents: this identity\'s files only, one chunk per section titled by heading, Codex snapshots labelled by host, repo from cwd', async () => {
    const docs = store.db.prepare("SELECT path, title, project, text FROM chunks WHERE kind = 'doc'").all();
    assert.ok(!docs.some((d) => /zebra/.test(d.text)), 'the other identity\'s documents are not indexed');
    const go = docs.find((d) => /native Go port/.test(d.text));
    assert.equal(go.title, 'Codex memory (box-a) › Task Group: Webapp build tooling and TypeScript compiler impact › Task 2: Explain what the TypeScript native Go port would speed up in Webapp');
    assert.equal(go.project, 'webapp');
    assert.ok(docs.some((d) => d.title === 'Codex memory › Task Group: Local notes › Task 1: Search index' && d.project === 'drover'), 'this host\'s own Codex memory');
    assert.ok(docs.some((d) => d.title === 'Webapp onboarding observations › Build tooling'));
    assert.ok(docs.some((d) => d.title === 'pnpm migration arguments › Verdict'));
    const hit = (await search(store, null, { query: 'typescript native go port', mode: 'keyword', kinds: ['doc'], project: 'webapp' })).results[0];
    assert.match(hit.title, /box-a/);
  });
  test('memory homes of the other identity are not indexed, and switching identity purges what no longer belongs', async () => {
    const mem = () => store.db.prepare("SELECT text FROM chunks WHERE kind = 'memory'").all().map((r) => r.text);
    assert.deepEqual(mem(), ['typecheck heap is 12 GB']);
    await make({ identity: 'personal', docs: [] }).tick();
    assert.deepEqual(mem(), ['tsgo core gate for openclaw walrus'], 'the work home is purged, the personal one indexed');
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE kind = 'doc'").get().n, 0, 'docs no pattern matches are purged');
    await make().tick();
    assert.deepEqual(mem(), ['typecheck heap is 12 GB']);
  });
  test('a document that cannot be read keeps what was indexed, and is read again once it can be', async () => {
    const { chmod, appendFile } = await import('node:fs/promises');
    const spec = path.join(dot, 'specs', '2026-05-20-pnpm-migration-arguments.md');
    const texts = () => store.db.prepare('SELECT text FROM chunks WHERE path = ?').all(spec).map((r) => r.text).join(' ');
    await appendFile(spec, '\n## Later\n\nadded after the first pass\n');
    await chmod(spec, 0o000);
    try { await make().tick(); assert.match(texts(), /Migrate after the bench/, 'nothing purged while unreadable'); }
    finally { await chmod(spec, 0o644); }
    await make().tick();
    assert.match(texts(), /added after the first pass/, 'the next pass reads it');
  });
  test('an unreadable memory-homes.conf purges no memory', async () => {
    await make({ memoryHomes: async () => { throw new Error('EIO'); } }).tick();
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE kind = 'memory'").get().n, 1);
  });
  test('a transcript read by an older extractor is read again once; unchanged text keeps its vectors', async () => {
    store.db.exec("DELETE FROM chunks WHERE role = 'command'; UPDATE sources SET xv = 1 WHERE kind = 'claude'");
    const vectors = store.stats().vectors, inputs = emb.inputs;
    const r = await make().tick();
    assert.equal(r.changed, 1, 'only the stale transcript is read');
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE role = 'command'").get().n, 1);
    assert.equal(store.source(file()).xv, EXTRACT_VERSION);
    assert.equal(store.stats().vectors, vectors); assert.equal(emb.inputs, inputs, 'nothing was embedded again');
    assert.equal((await make().tick()).changed, 0, 'and only once');
  });
  test('a host that indexes fewer kinds forgets the others (an archive host: transcripts only)', async () => {
    await make({ kinds: ['claude', 'subagent'] }).tick();
    const kinds = store.db.prepare('SELECT DISTINCT kind FROM chunks').all().map((r) => r.kind);
    assert.deepEqual(kinds, ['claude']);
    await make().tick();
    assert.ok(store.db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE kind = 'doc'").get().n > 0, 'turned back on, they come back');
  });
});

describe('fleet coverage', () => {
  // An ephemeral host (it comes and goes) and a host a plugin's host provider owns (pod:<name>, no ssh alias, most
  // run no Drover) are left out unless asked for by name.
  const known = [{ name: 'local', source: 'local' }, { name: 'devbox', source: 'fleet' }, { name: 'box-b', source: 'fleet' }, { name: 'box-a', source: 'fleet' }, { name: 'fresh-box', source: 'fleet' },
    { name: 'scratch-1', source: 'fleet', ephemeral: true }, { name: 'pod:ws1', source: 'pods' }];
  const probes = new Map([['box-a', { up: false, error: 'Connection refused' }], ['devbox', { up: true }], ['box-b', { up: true }]]);
  const perHost = [{ host: 'LAPTOP', ok: true, vector: 'ok' }, { host: 'devbox', ok: true, vector: 'unavailable' }, { host: 'box-b', ok: false, error: 'search index not built on box-b yet' }];
  const missed = [{ host: 'box-a', reason: 'down at the last probe: Connection refused' }, { host: 'fresh-box', reason: 'never probed' }];
  test('names every fleet host the search could not see, and the ones that answered by keyword only', () => {
    const before = fleetCoverage({ known, targets: ['local', 'devbox', 'box-b'], perHost, probes });
    assert.deepEqual(before.notCovered, [...missed, { host: 'pod:ws1', reason: 'never probed' }, { host: 'box-b', reason: 'search index not built on box-b yet' }], 'no plugin owns pod:ws1 yet: it is a fleet host like any other');
    plugins.register({ name: 'test-pods', hosts: { match: (name) => name.startsWith('pod:') } });
    const c = fleetCoverage({ known, targets: ['local', 'devbox', 'box-b'], perHost, probes });
    assert.deepEqual(c.searched, ['LAPTOP', 'devbox']);
    assert.deepEqual(c.notCovered, [...missed, { host: 'box-b', reason: 'search index not built on box-b yet' }]);
    assert.deepEqual(c.partial, [{ host: 'devbox', reason: 'keyword only (vectors unavailable)' }]);
    const asked = fleetCoverage({ known, targets: ['local', 'pod:ws1', 'scratch-1'], perHost: [{ host: 'pod:ws1', ok: false, error: 'no drover on pod:ws1' }, { host: 'scratch-1', ok: false, error: 'timed out' }], probes });
    assert.deepEqual(asked.notCovered.slice(-2), [{ host: 'pod:ws1', reason: 'no drover on pod:ws1' }, { host: 'scratch-1', reason: 'timed out' }], 'asked for and failed: reported');
  });
  test('hosts chosen by the caller: only their failures count; keyword mode is not partial', () => {
    const c = fleetCoverage({ known, targets: ['devbox'], perHost: [{ host: 'devbox', ok: true, vector: 'off' }], probes, chosen: true, vectors: false });
    assert.deepEqual(c, { searched: ['devbox'], notCovered: [], partial: [] });
  });
});
