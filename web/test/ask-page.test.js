// Pages: heads-ups for the owner that are not questions (a Grok bot's needs-owner or blocked status, its urgent
// alert), texted by the ask hub under the ask rules (core/ask/router.js page). A router with fake channels and an
// in-memory truth file; every number and id is made up.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Router, _deps } from '../core/ask/router.js';
import { foldAsks, validateAskEvent, pageText } from '../core/ask/model.js';
import { readConfig } from '../core/ask/policy.js';

const T0 = Date.parse('2026-11-10T15:00:00Z');   // 10:00 in New York: outside quiet hours
let now = T0, events = [], texts = [], failSms = false;
const env = { DROVER_ASK_HUB: 'hub' };
const fakeSms = {
  configured: () => true,
  send: async ({ text }) => { if (failSms) throw new Error('twilio down'); texts.push({ channel: 'sms', text }); return { providerId: `SM${texts.length}` }; },
};
const fakeTelegram = { configured: () => true, send: async ({ text }) => { texts.push({ channel: 'telegram', text }); return { providerId: `TG${texts.length}` }; } };

function setup(extraEnv = {}) {
  now = T0; events = []; texts = []; failSms = false;
  for (const k of Object.keys(env)) if (k !== 'DROVER_ASK_HUB') delete env[k];
  Object.assign(env, extraEnv);
  Object.assign(_deps, {
    append: async (ev) => { const e = validateAskEvent({ ...ev, ts: new Date(now).toISOString() }); events.push(e); return e; },
    readEvents: async () => events,
    now: () => now,
    hostName: () => 'hub',
    env,
    channels: { sms: fakeSms, telegram: fakeTelegram, imessage: { configured: () => false } },
    log: () => {},
  });
  return new Router();
}
const page = (r, over = {}) => r.page({ source: 'grok:izzy', key: 'grok:izzy|status|needs-owner|disk low', title: 'Izzy needs you', body: 'disk low on the Mac mini', ...over });

describe('pages', () => {
  let r;
  beforeEach(() => { r = setup(); });

  test('a needs-you page goes out by SMS at once, never on another channel, with no ask code', async () => {
    const res = await page(r);
    assert.equal(res.sent, true);
    assert.equal(texts.length, 1);
    assert.equal(texts[0].channel, 'sms');
    assert.match(texts[0].text, /^Drover: Izzy needs you: disk low on the Mac mini/);
    assert.doesNotMatch(texts[0].text, /\b[A-HJ-NP-Z]\d{1,2}\b/);
    const st = foldAsks(events);
    assert.equal(st.pages.size, 1);
    assert.ok([...st.pages.values()][0].sentAt);
    assert.equal(st.asks.size, 0, 'a page is not an ask');
  });

  test('the same status inside the cooldown is the same page: one text', async () => {
    await page(r);
    now += 20 * 60_000;
    const again = await page(r);
    assert.equal(again.deduped, true);
    assert.equal(texts.length, 1);
    now += 41 * 60_000;   // past the 60-minute cooldown
    const later = await page(r);
    assert.equal(later.sent, true);
    assert.equal(texts.length, 2);
  });

  test('one text per source per gap: a new status inside it waits, then goes', async () => {
    await page(r);
    now += 2 * 60_000;
    const res = await page(r, { key: 'grok:izzy|status|blocked|ssh fails', title: 'Izzy is blocked', body: 'ssh fails' });
    assert.equal(res.sent, false);
    assert.equal(res.held.why, 'one text per source per gap');
    assert.equal(texts.length, 1);
    now += 9 * 60_000;
    await r.tick();
    assert.equal(texts.length, 2);
    assert.match(texts[1].text, /Izzy is blocked: ssh fails/);
  });

  test('another bot is its own source: not held by the first one\'s gap', async () => {
    await page(r);
    const res = await page(r, { source: 'grok:merlin', key: 'grok:merlin|status|needs-owner|x', title: 'Merlin needs you', body: 'x' });
    assert.equal(res.sent, true);
    assert.equal(texts.length, 2);
  });

  test('quiet hours (22:00-08:00 New York) hold a normal page until morning; urgent goes through', async () => {
    now = Date.parse('2026-11-10T04:00:00Z');   // 23:00 in New York
    const res = await page(r);
    assert.equal(res.sent, false);
    assert.equal(res.held.why, 'quiet hours');
    const urgent = await page(r, { source: 'grok:ben', key: 'grok:ben|alert|card declined', title: 'Ben: card declined', urgent: true });
    assert.equal(urgent.sent, true);
    assert.equal(texts.length, 1);
    assert.match(texts[0].text, /URGENT Ben: card declined/);
    now = Date.parse('2026-11-10T13:01:00Z');   // 08:01
    await r.tick();
    assert.equal(texts.length, 2);
    assert.match(texts[1].text, /Izzy needs you/);
  });

  test('a page left unsent past the stale window is dropped, not texted late', async () => {
    r = setup({ DROVER_ASK_PAGE_STALE_HOURS: '1' });
    now = Date.parse('2026-11-10T04:00:00Z');   // 23:00: held
    await page(r);
    now = Date.parse('2026-11-10T13:01:00Z');   // 08:01, 9 hours later
    await r.tick();
    assert.equal(texts.length, 0);
  });

  test('the bot moving on withdraws its pages not texted yet', async () => {
    now = Date.parse('2026-11-10T04:00:00Z');   // quiet: held
    await page(r);
    const w = await r.withdrawPages('grok:izzy');
    assert.equal(w.withdrawn, 1);
    now = Date.parse('2026-11-10T13:01:00Z');
    await r.tick();
    assert.equal(texts.length, 0);
    assert.deepEqual(await r.withdrawPages('grok:izzy'), { withdrawn: 0 });
  });

  test('pages count against the hourly limit of 6, shared with asks; held ones go out together after', async () => {
    for (let i = 0; i < 8; i++) await page(r, { source: `grok:bot${i}`, key: `k${i}`, title: `Bot${i} needs you` });
    assert.equal(texts.length, 6);
    now += 61 * 60_000;
    await r.tick();
    assert.equal(texts.length, 7, 'the two held pages go in one text');
    assert.match(texts[6].text, /2 updates/);
    assert.match(texts[6].text, /Bot6 needs you/);
    assert.match(texts[6].text, /Bot7 needs you/);
  });

  test('the owner\'s stop holds every page, urgent too', async () => {
    events.push({ type: 'ask', phase: 'control', command: 'stop', ts: new Date(now - 1000).toISOString() });
    const res = await page(r, { urgent: true });
    assert.equal(res.sent, false);
    assert.equal(res.held.why, 'stopped');
    assert.equal(texts.length, 0);
  });

  test('a failed send is retried with the backoff, then lands', async () => {
    failSms = true;
    const res = await page(r);
    assert.equal(res.sent, false);
    assert.equal(res.held.why, 'every channel failed');
    failSms = false;
    now += 30_000;
    await r.tick();
    assert.equal(texts.length, 0, 'inside the 2-minute backoff');
    now += 2 * 60_000;
    await r.tick();
    assert.equal(texts.length, 1);
  });

  test('DROVER_ASK_PAGES=off: nothing recorded or sent', async () => {
    r = setup({ DROVER_ASK_PAGES: 'off' });
    const res = await page(r);
    assert.match(res.skipped, /off/);
    assert.equal(events.length, 0);
    assert.equal(texts.length, 0);
  });

  test('DROVER_ASK_PAGE_CHANNELS picks the channels; none usable holds the page', async () => {
    r = setup({ DROVER_ASK_PAGE_CHANNELS: 'imessage' });
    const res = await page(r);
    assert.equal(res.held.why, 'no page channel is configured on the hub');
    assert.equal(texts.length, 0);
  });
});

describe('page events and text', () => {
  test('validation', () => {
    assert.throws(() => validateAskEvent({ type: 'ask', phase: 'page', source: 'grok:x', key: 'k' }), /pageId/);
    assert.throws(() => validateAskEvent({ type: 'ask', phase: 'page', pageId: 'p', key: 'k', title: 't' }), /source/);
    assert.doesNotThrow(() => validateAskEvent({ type: 'ask', phase: 'page', source: 'grok:x', withdraw: true }));
    assert.doesNotThrow(() => validateAskEvent({ type: 'ask', phase: 'sent', askIds: [], pageIds: ['p'], channel: 'sms', kind: 'page' }));
  });
  test('the fold is order-tolerant: a send read before its page still marks it sent', () => {
    const st = foldAsks([
      { type: 'ask', phase: 'sent', askIds: [], pageIds: ['p1'], channel: 'sms', kind: 'page', ok: true, ts: '2026-11-10T15:00:01Z' },
      { type: 'ask', phase: 'page', pageId: 'p1', source: 'grok:x', key: 'k', title: 'X needs you', ts: '2026-11-10T15:00:00Z' },
    ]);
    assert.equal(st.pages.get('p1').sentAt, '2026-11-10T15:00:01Z');
  });
  test('one SMS fits however many pages', () => {
    const pages = Array.from({ length: 30 }, (_, i) => ({ title: `Bot${i} needs you`, body: 'x'.repeat(500), urgent: false }));
    assert.ok(pageText(pages).length <= 1600);
  });
  test('defaults: SMS only, 60-minute cooldown, 10-minute gap, 12-hour staleness', () => {
    const c = readConfig({});
    assert.deepEqual(c.pageChannels, ['sms']);
    assert.equal(c.pageCooldownMs, 3_600_000);
    assert.equal(c.pageGapMs, 600_000);
    assert.equal(c.pageStaleMs, 12 * 3_600_000);
    assert.equal(c.pages, true);
  });
});
