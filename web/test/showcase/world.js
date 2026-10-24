// The showcase world: what test/devworld.js --showcase builds on top of the dev world, for screenshots and demos of
// every client. Three hosts: studio runs the daemon, devbox is reached through the stand-in ssh (fake-ssh.js) and
// spare is down. Every engine Drover drives: Claude Code sessions in tmux (test/fake-agent.js), Codex threads
// (fake-codex.js), two Grok bots and the OpenClaw manager (test/fake-gateway.js). Docker compose stacks (fake-docker.js,
// from test/fixtures/docker-inspect.jsonl, with git checkouts behind them) and a truth file with features, notes,
// launches and messages. It all runs on this machine under one directory, with a HOME of its own; every name and every
// line in it is invented.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uuidv7 } from '../../core/ids.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'fixtures', 'docker-inspect.jsonl');
const OWNER = 'owner';

/** The hosts, the front one first: each one's Claude Code sessions (a fake-agent mode each) and their folders under HOME. */
const HOSTS = [
  { name: 'studio', agents: [
    { name: 'demo-build', mode: 'dialog', cwd: 'code/demo', title: 'Parser errors carry line numbers' },
    { name: 'demo-docs', mode: 'busy', cwd: 'code/docs', task: 'Rewriting the setup guide', title: 'Rewrite the setup guide' },
  ] },
  { name: 'devbox', agents: [
    { name: 'demo-review', mode: 'question', cwd: 'code/demo', title: 'Review the parser change' },
    { name: 'demo-lint', mode: 'busy', cwd: 'src/lint', task: 'Fixing lint in the API', title: 'Fix lint in the API' },
    { name: 'demo-notes', mode: 'idle', cwd: 'notes', title: 'Reorganise the notes', done: 'Done. The notes are in three folders now: projects, people and reference.' },
  ] },
  { name: 'spare', down: 'ssh: connect to host spare port 22: Operation timed out' },
];

/** Codex threads per host, each with its rollout (the transcript the daemon reads): items as a rollout records them. */
const CODEX = {
  studio: [{
    name: 'demo-parser', cwd: 'code/demo', status: 'active', loaded: true, minutesAgo: 1,
    preview: 'Make the parser accept trailing commas in arrays and objects, with tests.',
    items: [
      ['user', 'Make the parser accept trailing commas in arrays and objects, with tests.'],
      ['assistant', 'I will find where the parser rejects the comma, allow it before `]` and `}`, then add tests for both.'],
      ['shell', 'rg -n "trailing" src', 'Process exited with code 0\nOutput:\nsrc/lexer.ts:41:  // trailing commas are not allowed yet\nsrc/parser.ts:88:  if (next.kind === "comma" && peek().kind === "close") throw syntax("trailing comma")'],
      ['shell', "sed -n 80,96p src/parser.ts", 'Process exited with code 0\nOutput:\n  function list(close: Kind) {\n    const items = [];\n    while (peek().kind !== close) {\n      items.push(value());\n      if (peek().kind === "comma") take();\n    }'],
      ['assistant', 'The check on line 88 is the only place that rejects it. Removing it and adding four tests.'],
      ['shell', 'npm test -- parser', null],
    ],
  }],
  devbox: [{
    name: 'demo-flaky', cwd: 'src/webapp', status: 'idle', loaded: true, minutesAgo: 24,
    preview: 'Find out why checkout_test flakes on CI.',
    items: [
      ['user', 'Find out why checkout_test flakes on CI.'],
      ['shell', 'for i in $(seq 50); do npx vitest run checkout_test -t total >/dev/null || echo fail $i; done', 'Process exited with code 0\nOutput:\nfail 7\nfail 31\nfail 44'],
      ['assistant', 'Three failures in 50 runs. The test reads the cart total before the async price update lands. Making it await `priceUpdated`.'],
      ['shell', 'for i in $(seq 200); do npx vitest run checkout_test -t total >/dev/null || echo fail $i; done; echo done', 'Process exited with code 0\nOutput:\ndone'],
      ['assistant', 'Fixed: the test now awaits `priceUpdated`, and it passed 200 runs in a row. Want me to open a pull request?'],
    ],
  }],
};

/** What the manager (the fake gateway) answers, in turn: about this world, so a reply matches the board beside it. */
export const REPLIES = [
  'Three things are waiting on you: **demo-build** on studio wants to run `npm test` (a permission prompt), **demo-review** on devbox asked whether the review should cover the test fixtures, and the Grok bot **Scout** wants your OK to publish the v0.4 release notes.\n\nEverything else is moving: demo-docs is rewriting the setup guide, demo-lint is fixing lint on devbox, and the Codex thread demo-parser is running the parser tests.',
  'Since your last look: demo-notes finished reorganising the notes, the Codex thread demo-flaky fixed the flaky checkout test and asks whether to open a pull request, and the `webapp` stack on studio has one unhealthy service (web-app-reports fails its health check).',
  'studio and devbox answer; spare has not answered ssh since this morning. studio runs 2 Claude Code sessions, a Codex thread, both Grok bots and me; devbox runs 3 Claude Code sessions and a Codex thread.',
];

const git = (cwd, args) => {
  const who = { GIT_AUTHOR_NAME: 'Demo Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Demo Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
  // No global or system config: the owner's signing, hooks and identity stay out of these checkouts.
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...who, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};
/** A checkout with a short history on a branch, optionally with an uncommitted change. */
function checkout(dir, branch, commits, dirty) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(path.join(dir, 'README.md'), `# ${path.basename(dir)}\n`);
  git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'chore: initial commit']);
  git(dir, ['switch', '-q', '-c', branch]);
  commits.forEach((msg, i) => { writeFileSync(path.join(dir, `change-${i}.txt`), `${msg}\n`); git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', msg]); });
  if (dirty) { mkdirSync(path.dirname(path.join(dir, dirty)), { recursive: true }); writeFileSync(path.join(dir, dirty), 'work in progress\n'); }
}

/**
 * Lay the world out under dir and say how devworld.js runs it: the HOME every process gets, the front host's
 * agents and settings, every other host (its folder, agents and environment), what the stand-in ssh reads, the
 * manager's replies and the host list the daemon must show. base is the environment the dev world gives its
 * processes (secrets already removed); root is web/; home is the HOME every process here gets.
 */
export function prepare({ dir, root, base, home = path.join(dir, 'home'), now = Date.now() }) {
  const bin = path.join(dir, 'bin');
  const iso = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
  for (const h of HOSTS) for (const a of h.agents ?? []) mkdirSync(path.join(home, a.cwd), { recursive: true });

  // ---- the projects the agents work in (each its own checkout, as on a real machine) and the code the stacks run
  checkout(path.join(home, 'code', 'demo'), 'feat/line-numbers', ['feat(lexer): line numbers in errors']);
  checkout(path.join(home, 'code', 'docs'), 'docs/setup-guide', ['docs: outline the new installer']);
  checkout(path.join(home, 'src', 'lint'), 'fix/api-lint', ['style(api): sort imports']);
  checkout(path.join(home, 'src', 'webapp'), 'feat/reports', ['feat(reports): weekly totals', 'fix(reports): empty weeks'], 'src/reports.ts');
  checkout(path.join(home, 'src', 'webapp-review'), 'review/notify-retry', ['feat(notify): retry failed sends']);

  // ---- docker: the fixture's webapp stack on studio and webapp-review on devbox, their paths moved under HOME
  const lines = readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean)
    .map((l) => l.replaceAll('/home/dev/', `${home}/`).replaceAll('/srv/webapp-review', path.join(home, 'src', 'webapp-review')))
    .map((l) => JSON.parse(l));
  const project = (c) => c.labels?.['com.docker.compose.project'];
  const containers = {
    studio: lines.filter((c) => project(c) === 'webapp'),
    devbox: lines.filter((c) => project(c) === 'webapp-review'),
  };

  // ---- the hosts: the front one is this daemon, the others answer through the stand-in ssh
  const env = (name, hostDir) => ({
    HOME: home, DROVER_HOST: name, DROVER_VITALS: 'off',
    DROVER_DOCKER: path.join(bin, 'docker'), DEVWORLD_CONTAINERS: path.join(dir, `containers-${name}.jsonl`),
    DROVER_DOCKER_KINDS: JSON.stringify([{ kind: 'app', match: '^web-app-', label: 'apps' }, { kind: 'ml', match: '^web-ml-', label: 'ML' }, { kind: 'core', match: '^web-' }]),
    // Another host runs no manager: its state dir is its own and empty, so the HOME it shares with studio (where
    // studio's manager lives) is not read, and nothing falls back to a real gateway on this machine's default port.
    ...(hostDir ? { DROVER_STATE: path.join(hostDir, 'state'), DROVER_CACHE: path.join(hostDir, 'cache'), DROVER_SHARE: path.join(hostDir, 'share'), CLAUDE_CONFIG_DIR: path.join(hostDir, 'claude'), CODEX_HOME: path.join(hostDir, 'codex'), OPENCLAW_MANAGER_STATE_DIR: path.join(hostDir, 'no-manager'), OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:9' } : {}),
  });
  const [front, ...others] = HOSTS;
  const remotes = others.map((h) => {
    const hostDir = path.join(dir, 'hosts', h.name);
    if (h.down) return { name: h.name, down: h.down, agents: [] };
    // Sockets (its tmux server's, its agents' inboxes) under a short folder: a socket path has at most 103 characters
    // on macOS, and the system's temporary folder there is long.
    const run = path.join('/tmp', path.basename(dir), h.name);
    for (const d of ['state', 'cache', 'claude/sessions', 'claude/projects', 'codex']) mkdirSync(path.join(hostDir, d), { recursive: true });
    for (const d of ['tmux', 'socks']) mkdirSync(path.join(run, d), { recursive: true, mode: 0o700 });
    return { name: h.name, dir: hostDir, run, socks: path.join(run, 'socks'), agents: h.agents.map((a) => ({ ...a, cwd: path.join(home, a.cwd) })), env: { ...base, ...env(h.name, hostDir), TMUX_TMPDIR: path.join(run, 'tmux'), PATH: `${bin}:${base.PATH}` } };
  });
  for (const h of HOSTS) if (containers[h.name]) writeFileSync(path.join(dir, `containers-${h.name}.jsonl`), containers[h.name].map((c) => JSON.stringify(c)).join('\n') + '\n');

  // ---- Codex: each host's threads (fake-codex.js lists them) and rollouts (the daemon reads them)
  const codexHome = (name) => (name === front.name ? path.join(dir, 'codex') : path.join(dir, 'hosts', name, 'codex'));
  for (const [host, threads] of Object.entries(CODEX)) {
    const listed = threads.map((t) => {
      const id = randomUUID();
      const started = new Date(now - (t.minutesAgo + 12) * 60_000);
      const stamp = started.toISOString().slice(0, 19).replace(/:/g, '-');
      const day = path.join(codexHome(host), 'sessions', ...started.toISOString().slice(0, 10).split('-'));
      mkdirSync(day, { recursive: true });
      let ts = started.getTime();
      const at = () => new Date((ts += 40_000)).toISOString();
      const rows = [{ timestamp: at(), type: 'session_meta', payload: { id, cwd: path.join(home, t.cwd), model_provider: 'openai', originator: 'codex_cli_rs', cli_version: '0.163.0', timestamp: started.toISOString() } }];
      t.items.forEach(([kind, text, output], i) => {
        if (kind === 'user' || kind === 'assistant') { rows.push({ timestamp: at(), type: 'response_item', payload: { type: 'message', role: kind, content: [{ type: kind === 'user' ? 'input_text' : 'output_text', text }] } }); return; }
        const call = `call_${i}`;
        rows.push({ timestamp: at(), type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', text] }), call_id: call } });
        if (output !== null) rows.push({ timestamp: at(), type: 'response_item', payload: { type: 'function_call_output', call_id: call, output } });
      });
      writeFileSync(path.join(day, `rollout-${stamp}-${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      const updated = Math.round((now - t.minutesAgo * 60_000) / 1000);
      return { id, name: t.name, cwd: path.join(home, t.cwd), status: { type: t.status }, model: 'gpt-5.5-codex', modelProvider: 'openai', createdAt: Math.round(started.getTime() / 1000), updatedAt: updated, preview: t.preview, source: 'cli', loaded: t.loaded };
    });
    mkdirSync(codexHome(host), { recursive: true });
    writeFileSync(path.join(codexHome(host), 'showcase-threads.json'), JSON.stringify(listed, null, 1));
  }

  // ---- the truth file: Grok bots report here (studio keeps them: its state has bots/), plus a fleet's worth of history
  mkdirSync(path.join(dir, 'state', 'bots'), { recursive: true });
  const ev = (minutesAgo, host, actor, body) => ({ id: uuidv7(), ts: iso(minutesAgo), host, actor, ...body });
  const toBot = (name) => ({ kind: 'grok', id: `grok:${name}`, name: name.charAt(0).toUpperCase() + name.slice(1) });
  const askScout = ev(90, 'studio', OWNER, { type: 'message', to: toBot('scout'), text: 'Draft the v0.4 release notes from this week\'s merges.', delivery: { ok: true, via: 'grok routine webhook' } });
  const events = [
    ev(130, 'studio', OWNER, { type: 'feature', fid: 'parser-line-numbers', title: 'Parser errors carry line numbers', state: 'in-progress', repo: 'demo', branch: 'feat/line-numbers' }),
    ev(118, 'studio', OWNER, { type: 'launch', engine: 'claude', mode: 'tmux', profile: 'claude-default', cwd: '~/code/demo', host: 'studio', prompt: 'Make parser errors carry line numbers, then run the tests', result: { tmux: 'work:1' } }),
    ev(96, 'devbox', OWNER, { type: 'launch', engine: 'claude', mode: 'tmux', profile: 'claude-default', cwd: '~/code/demo', host: 'devbox', prompt: 'Review the parser change on feat/line-numbers', result: { tmux: 'work:1' } }),
    askScout,
    ev(84, 'studio', 'grok:scout', { type: 'status', agent: 'grok:scout', state: 'working', summary: 'Reading this week\'s merged pull requests', task: 'v0.4 release notes', name: 'Scout', source: 'grok:scout', untrusted: true }),
    ev(75, 'studio', OWNER, { type: 'feature', fid: 'setup-guide', title: 'Rewrite the setup guide for the new installer', state: 'in-progress', repo: 'docs' }),
    ev(72, 'studio', OWNER, { type: 'launch', engine: 'claude', mode: 'tmux', profile: 'claude-default', cwd: '~/code/docs', host: 'studio', prompt: 'Rewrite the setup guide for the new installer', result: { tmux: 'work:2' } }),
    ev(64, 'devbox', OWNER, { type: 'launch', engine: 'codex', mode: 'tmux', profile: 'codex-default', cwd: '~/src/webapp', host: 'devbox', prompt: 'Find out why checkout_test flakes on CI', result: { tmux: 'work:4' } }),
    ev(58, 'devbox', 'claude:demo-review', { type: 'note', about: 'parser-line-numbers', text: 'Reviewed the lexer half: line numbers start at 1 now; the parser half is next.' }),
    ev(41, 'studio', OWNER, { type: 'message', to: toBot('atlas'), text: 'Triage the issues that came in over the weekend.', delivery: { ok: true, via: 'grok routine webhook' } }),
    ev(33, 'devbox', OWNER, { type: 'feature', fid: 'checkout-flake', title: 'Fix the flaky checkout test', state: 'shipped', repo: 'webapp', branch: 'fix/checkout-flake' }),
    ev(27, 'devbox', OWNER, { type: 'launch', engine: 'claude', mode: 'tmux', profile: 'claude-default', cwd: '~/src/lint', host: 'devbox', prompt: 'Fix the lint errors in the API package', result: { tmux: 'work:2' } }),
    ev(18, 'studio', OWNER, { type: 'launch', engine: 'codex', mode: 'tmux', profile: 'codex-default', cwd: '~/code/demo', host: 'studio', prompt: 'Make the parser accept trailing commas', result: { tmux: 'work:3' } }),
    ev(9, 'studio', 'grok:atlas', { type: 'status', agent: 'grok:atlas', state: 'working', summary: 'Triaging the 9 issues opened over the weekend: 4 labelled, 2 duplicates closed', task: 'weekend triage', name: 'Atlas', source: 'grok:atlas', untrusted: true }),
    ev(7, 'studio', 'grok:scout', { type: 'chat', to: { ...toBot('scout'), host: 'studio' }, from: 'grok:scout', inReplyTo: askScout.id, text: 'The v0.4 release notes are drafted from 14 merged pull requests: 3 features, 9 fixes, 2 docs changes. They need your OK before I publish them.', source: 'grok:scout', untrusted: true }),
    ev(6, 'studio', 'grok:scout', { type: 'status', agent: 'grok:scout', state: 'needs-owner', summary: 'The v0.4 release notes are ready: publish them?', task: 'v0.4 release notes', name: 'Scout', source: 'grok:scout', untrusted: true }),
    ev(3, 'devbox', 'claude:demo-notes', { type: 'note', about: 'notes', text: 'Notes reorganised into three folders: projects, people, reference.' }),
  ];
  writeFileSync(path.join(dir, 'dotfiles', 'claude', 'drover-events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(path.join(dir, 'dotfiles', 'claude', 'fleet-hosts.txt'), others.map((h) => h.name).join('\n') + '\n');

  // ---- what the stand-in ssh reads: each host's environment, or why it does not answer
  const hostsFile = path.join(dir, 'hosts.json');
  writeFileSync(hostsFile, JSON.stringify({ drover: path.join(root, 'bin', 'drover'), hosts: Object.fromEntries(remotes.map((r) => [r.name, r.down ? { down: r.down } : { env: r.env }])) }, null, 1));

  return {
    home,
    front: { name: front.name, agents: front.agents.map((a) => ({ ...a, cwd: path.join(home, a.cwd) })), env: env(front.name, null) },
    remotes: remotes.filter((r) => !r.down),
    hostsFile,
    replies: REPLIES,
    expectedHosts: ['local', ...others.map((h) => h.name)],
  };
}
