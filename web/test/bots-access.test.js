import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resourceAccess, accessForGrant, tenantAccess, delegatedFeatures, tenantBot } from '../core/bots/access.js';
import { botTools } from '../core/bots/tools.js';
import { fold } from '../core/events.js';

// Bot names follow DROVER_TENANT_PREFIX (tenantBot): these tests hold for any configured prefix.
const ALICE_BOT = tenantBot('alice');
const policy = { version: 1, tenant: 'alice', bot: ALICE_BOT, requester: 'user:alice', projects: ['/code/Alpha'], hosts: ['box-a'] };
const grant = { grantId: 'grant_alice', bot: policy.bot, scopes: ['drover.read', 'drover.write'], resourceAccess: policy };
const fixture = (patch = {}) => ({ ...policy, projects: [...policy.projects], hosts: [...policy.hosts], ...patch });

describe('native tenant resource access policy', () => {
  test('explicit exact authority, copied and pinned to tenant and bot; legacy is only for grants that are not tenants', () => {
    const copied = resourceAccess(policy.bot, policy);
    assert.deepEqual(copied, policy);
    copied.projects.push('/code/Beta');
    assert.deepEqual(policy.projects, ['/code/Alpha']);
    assert.equal(accessForGrant({ bot: 'alpha' }), null);
    assert.equal(accessForGrant({ bot: '*' }), null);
    for (const bot of [ALICE_BOT, tenantBot(''), tenantBot('bob')]) assert.throws(() => accessForGrant({ bot }), /invalid resource delegation/);
    assert.throws(() => accessForGrant({ bot: 'alpha', resourceAccess: policy }), /invalid resource delegation/);
  });

  test('malformed authority never broadens access: wildcards, paths, prototypes, blanks, wrong types, missing fields and foreign principal', () => {
    const bad = [null, [], {}, fixture({ version: 2 }), fixture({ tenant: 'bob' }), fixture({ bot: tenantBot('bob') }), fixture({ requester: '' }), fixture({ requester: 'user:alice\nadmin' }), fixture({ requester: 123 }), fixture({ extra: true }), fixture({ projects: [] }), fixture({ hosts: [] }), fixture({ projects: '/code/Alpha' }), fixture({ hosts: null }), fixture({ projects: ['/code/Alpha', '/code/Alpha'] }), fixture({ hosts: ['local'] }), fixture({ projects: Array(1) }), fixture({ projects: ['Alpha'] }), fixture({ projects: ['/'] }), fixture({ projects: ['/code/Alpha/'] }), fixture({ projects: ['/code//Alpha'] }), fixture({ projects: ['/code/../Alpha'] }), fixture({ projects: ['~/code/Alpha'] })];
    for (const name of ['*', 'Alpha*', 'Alpha?', 'Alpha/secret', '../Alpha', '.', '..', '__proto__', 'constructor', 'prototype', ' Alpha', 'Alpha ', 'A\nB', '-flag', 'a'.repeat(129), 1, null]) bad.push(fixture({ projects: [name] }), fixture({ hosts: [name] }));
    for (const p of bad) assert.throws(() => resourceAccess(policy.bot, p), /invalid resource delegation/, JSON.stringify(p));
    const inherited = Object.create(policy);
    assert.throws(() => resourceAccess(policy.bot, inherited), /invalid resource delegation/);
    assert.throws(() => botTools({ ...grant, resourceAccess: undefined }, { dispatch: async () => ({}) }), /invalid resource delegation/);
  });

  test('records need explicit exact projects AND known hosts, not fuzzy aliases or conflicting metadata', () => {
    const a = tenantAccess(grant, 'box-a');
    assert.deepEqual(a.queryHosts, ['local']);
    assert.equal(a.record({ project: '/code/Alpha', host: 'box-a' }), true);
    assert.equal(a.record({ project: 'Alpha', cwd: '/code/Alpha', host: 'box-a' }), true, 'display label needs exact cwd');
    assert.equal(a.record({ cwd: '/code/Alpha/.claude/worktrees/fix', host: 'box-a' }), false, 'worktrees require explicit approval');
    assert.equal(a.record({ repo: '/code/Alpha' }, { sourceHost: 'box-a' }), true, 'a trusted adapter source can establish host provenance');
    for (const row of [{}, { repo: '/code/Alpha' }, { repo: '/code/Alpha', host: null }, { repo: '/code/Alpha', host: 'unknown' }, { host: 'box-a' }, { repo: '*', host: 'box-a' }, { repo: '/code/alpha', host: 'box-a' }, { repo: '/code/Alpha-secret', host: 'box-a' }, { repo: '/code/Alpha', project: '/code/Beta', host: 'box-a' }, { repo: '/code/Alpha', host: 'box-a', hosts: ['box-a', 'other'] }, { repo: '/code/Alpha', host: 'box-a', hosts: '*' }, { repo: 'Alpha', host: 'box-a' }, { cwd: '/secret/Alpha', project: 'Alpha', host: 'box-a' }, { cwd: '/secret/Alpha', repo: '/code/Alpha', host: 'box-a' }, { cwd: '/code/Alpha/../Alpha', host: 'box-a' }, { cwd: '/code/Alpha/', host: 'box-a' }, { cwd: '/code//Alpha', host: 'box-a' }, { cwd: 'Alpha', repo: '/code/Alpha', host: 'box-a' }]) assert.equal(a.record(row), false, JSON.stringify(row));
    for (const project of ['*', '/code/Alpha-secret', '/other/Alpha', '/code/alpha', '/code/Beta', 'Alpha']) assert.throws(() => a.project(project), /access denied/);
    assert.throws(() => tenantAccess(grant, 'other').local(), /access denied/);
  });

  test('features retain complete project/host provenance, including unknown contributions and moves into an allowed repo', () => {
    const a = tenantAccess(grant, 'box-a');
    const feature = (fid, repo = '/code/Alpha', host = 'box-a') => ({ type: 'feature', fid, repo, host, title: fid });
    const evs = [feature('ok'), { type: 'feature', fid: 'ok', host: 'box-a', notes: 'updated' }, feature('bad-project', '/code/Beta'), feature('bad-host', '/code/Alpha', 'other'), feature('missing-host', '/code/Alpha', undefined), feature('moved', '/code/Beta'), feature('moved'), feature('tainted'), { type: 'feature', fid: 'tainted', notes: 'unknown host' }];
    // Explicit missing host (the default parameter above would otherwise supply box-a).
    delete evs.find((e) => e.fid === 'missing-host').host;
    assert.deepEqual(delegatedFeatures(evs, a, fold).map((f) => f.fid), ['ok']);
  });

  test('tool reads constrain dispatch, filter hostile mixed responses and never release fleet/search coverage', async () => {
    const calls = [];
    const dispatch = async (op, args) => {
      calls.push({ op, args });
      if (op === 'fleet.summary') return { ts: 'secret global timestamp', coverage: { secret: true }, hosts: [{ host: 'local', sessions: [{ id: 'ok', live: true, cwd: '/code/Alpha', status: 'busy' }, { id: 'same-name', live: true, cwd: '/secret/Alpha' }, { id: 'no', live: true, cwd: '/code/Beta' }, { id: 'unknown', live: true }, { id: 'other-host', live: true, project: '/code/Alpha', host: 'other' }, { id: 'grok:bob', engine: 'grok', live: true, project: '/code/Alpha' }] }, { host: 'other', sessions: [{ id: 'private', project: '/code/Alpha', live: true }] }] };
      if (op === 'search.fleet') return { results: [{ kind: 'claude', title: 'ok', snippet: 'ok snippet', project: 'Alpha', cwd: '/code/Alpha', host: 'box-a', hosts: ['box-a'], origins: [{ cwd: '/code/Alpha', host: 'box-a' }] },
        // Per-chunk provenance is what authorizes: a source-level cwd or label without it, a copy without it, a foreign
        // checkout or origin host in any folded copy, or a reflection whose repo label contradicts its checkout withholds the hit.
        { kind: 'claude', title: 'source cwd only', project: 'Alpha', cwd: '/code/Alpha', host: 'box-a', hosts: ['box-a'] },
        { kind: 'claude', title: 'later turn elsewhere', project: 'Alpha', cwd: '/code/Alpha', host: 'box-a', hosts: ['box-a'], origins: [{ cwd: '/secret/Alpha', host: 'box-a' }] },
        { kind: 'claude', title: 'one unknown copy', project: 'Alpha', cwd: '/code/Alpha', host: 'box-a', hosts: ['box-a'], origins: [{ cwd: '/code/Alpha', host: 'box-a' }, null] },
        { kind: 'reflection', title: 'written on another host', repo: 'Alpha', cwd: '/code/Alpha', host: 'box-a', hosts: ['box-a'], origins: [{ cwd: '/code/Alpha', host: 'other' }] },
        { kind: 'reflection', title: 'no origin host', repo: 'Alpha', cwd: '/code/Alpha', host: 'box-a', hosts: ['box-a'], origins: [{ cwd: '/code/Alpha', host: null }] },
        { kind: 'reflection', title: 'label contradicts checkout', repo: '/code/Beta', cwd: '/code/Alpha', host: 'box-a', hosts: ['box-a'], origins: [{ cwd: '/code/Alpha', host: 'box-a' }] },
        { kind: 'reflection', title: 'reflection ok', repo: 'Alpha', id: 'r1', cwd: '/code/Alpha', host: 'box-a', hosts: ['box-a'], origins: [{ cwd: '/code/Alpha', host: 'box-a' }], score: -1 },
        { kind: 'claude', title: 'private', project: '/code/Beta', host: 'box-a' }, { kind: 'claude', title: 'unknown host', project: '/code/Alpha' }, { kind: 'claude', title: 'unknown project', host: 'box-a' }, { kind: 'claude', title: 'lookalike', project: '/code/Alpha-secret', host: 'box-a' }, { kind: 'claude', title: 'same basename', project: 'Alpha', cwd: '/secret/Alpha', host: 'box-a' }, { kind: 'claude', title: 'bare label', project: 'Alpha', host: 'box-a' }, { kind: 'wal', title: 'broadcast', project: '/code/Alpha', host: 'box-a', sessionId: 'grok:*' }, { kind: 'wal', title: 'other bot', project: '/code/Alpha', host: 'box-a', sessionId: 'grok:bob' }], coverage: { searched: ['box-a', 'other'], notCovered: ['secret-host'] }, perHost: ['private'] };
      throw new Error('unexpected global op');
    };
    const tools = botTools(grant, { dispatch, host: 'box-a', readEvents: async () => [] });
    const run = (name, args = {}) => tools.find((t) => t.name === name).run(null, args);
    assert.equal(tools.some((t) => /brain|notify|launch|op$|shell/.test(t.name)), false);
    assert.ok(tools.every((t) => !t.inputSchema.properties.host && !t.inputSchema.properties.bot && !t.inputSchema.properties.actor && !t.inputSchema.properties.resourceAccess));
    const fleet = await run('drover_fleet');
    assert.deepEqual(fleet.hosts.map((h) => h.host), ['box-a']);
    assert.deepEqual(fleet.hosts[0].sessions.map((s) => s.id), ['ok']);
    assert.equal(fleet.hosts[0].counts.total, 1);
    assert.equal(fleet.ts, undefined);
    const search = await run('drover_search', { query: 'work' });
    assert.deepEqual(search.results.map((r) => r.snippet ?? r.title), ['ok snippet', 'reflection ok']);
    assert.equal(search.results[0].title, null, 'a transcript\'s session title is withheld');
    assert.equal(search.searched, undefined); assert.equal(search.coverage, undefined);
    assert.deepEqual(calls.map((c) => c.args.hosts), [['local'], ['local']]);
    assert.equal(calls[1].args.repoIdentity, '/code/Alpha');
    assert.equal(calls[1].args.project, '/code/Alpha', 'older peers still receive an absolute scope');
    assert.deepEqual(calls[1].args.originHosts, ['box-a'], 'origin hosts are the approved hosts, never "local"');
    assert.equal(search.results[0].project, '/code/Alpha');
    const before = calls.length;
    await assert.rejects(run('drover_search', { query: 'x', project: '/code/Beta' }), /access denied/);
    assert.equal(calls.length, before, 'foreign project refused before dispatch');
  });

  test('approved home checkout identities round-trip verbatim rather than becoming ~ aliases', async () => {
    const repo = `${process.env.HOME}/code/Alpha`;
    const tools = botTools({ ...grant, resourceAccess: fixture({ projects: [repo] }) }, { dispatch: async () => ({}), host: 'box-a', readEvents: async () => [] });
    const me = await tools.find((t) => t.name === 'drover_whoami').run(null, {});
    assert.deepEqual(me.connection.resourceAccess.projects, [repo]);
  });

  test('reflection exact id membership and feature update stored provenance checked before id reads/writes', async () => {
    const calls = [], evs = [{ type: 'feature', fid: 'ok-feature', repo: '/code/Alpha', host: 'box-a' }, { type: 'feature', fid: 'private-feature', repo: '/code/Beta', host: 'box-a' }];
    const dispatch = async (op, args) => {
      calls.push({ op, args });
      if (op === 'reflections.list') return { items: [{ id: 'ok-reflection', repo: '/code/Alpha', checkout: '/code/Alpha', host: 'box-a', title: 'ok' }, { id: 'no-host', repo: '/code/Alpha', checkout: '/code/Alpha', title: 'unknown origin' }, { id: 'private-reflection', repo: '/code/Beta', checkout: '/code/Beta', title: 'secret' }, { id: 'foreign-host', repo: '/code/Alpha', checkout: '/code/Alpha', host: 'other' }, { id: 'cwd-only', repo: '/code/Alpha', cwd: '/code/Alpha', host: 'box-a' }, { id: 'worktree', repo: 'Alpha', checkout: '/code/Alpha-wt', cwd: '/code/Alpha', host: 'box-a' }] };
      if (op === 'reflections.show') return { id: args.id, repo: '/code/Beta', title: 'adapter returned wrong repo' };
      if (op === 'events.append') return { ...args.event, id: 'write-id' };
      throw new Error('private adapter error with secret names');
    };
    const tools = botTools(grant, { dispatch, host: 'box-a', readEvents: async () => evs });
    const run = (name, args) => tools.find((t) => t.name === name).run(null, args);
    for (const wanted of ['private-reflection', 'foreign-host', 'no-host', 'cwd-only', 'worktree', 'ok-ref', 'missing']) {
      await assert.rejects(run('drover_reflections', { action: 'show', repo: '/code/Alpha', id: wanted }), /access denied/);
      assert.ok(!calls.some((c) => c.op === 'reflections.show'), 'no global id lookup without membership');
    }
    await assert.rejects(run('drover_reflections', { action: 'show', repo: '/code/Alpha', id: 'ok-reflection' }), /access denied/, 'show response checked again');
    for (const fid of ['private-feature', 'missing', 'ok']) await assert.rejects(run('drover_feature_upsert', { repo: '/code/Alpha', fid }), /access denied/);
    assert.ok(!calls.some((c) => c.op === 'events.append'));
    await run('drover_feature_upsert', { repo: '/code/Alpha', fid: 'ok-feature', notes: 'changed' });
    const last = calls.at(-1);
    assert.equal(last.op, 'events.append'); assert.equal(last.args.actor, `grok:${ALICE_BOT}`);
    assert.deepEqual(last.args.event.delegation, { tenant: 'alice', bot: ALICE_BOT, requester: 'user:alice', grantId: 'grant_alice' });
    assert.match(last.args.event.notes, new RegExp(`^\\[untrusted: grok:${ALICE_BOT}\\]`));
    await assert.rejects(run('drover_note', { repo: '/code/Alpha', about: 'private-feature', text: 'wrong' }), /access denied/);
  });
});
