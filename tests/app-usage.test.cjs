const test = require('node:test');
const assert = require('node:assert/strict');
const { createAppUsageTracker, usageSessionIdleMs } = require('../src/core/app-usage-session.ts');
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function harness(saved = 'saved-installation-000001') {
  let time = Date.parse('2026-11-07T12:00:00Z'), next = 0, success = true, failStorage = false;
  const sends = [], writes = [];
  const tracker = createAppUsageTracker({
    platform: 'ios', now: () => time, uuid: () => `generated-uuid-${++next}-0000`,
    readId: async () => { if (failStorage) throw Error('locked'); return saved; },
    writeId: async id => { writes.push(id); saved = id; },
    send: async value => { sends.push(value); return success; },
  });
  return { tracker, sends, writes, advance: ms => { time += ms; }, at: value => { time = Date.parse(value); }, fail: () => { success = false; }, failStorage: () => { failStorage = true; } };
}

test('anonymous telemetry persists one install id, ignores duplicate starts and remains silent in background', async () => {
  const h = harness(null);
  h.tracker.foreground(); h.tracker.foreground(); await tick();
  assert.equal(h.sends.length, 1); assert.equal(h.writes.length, 1);
  assert.equal(h.sends[0].visitorId, h.writes[0]);
  h.tracker.background(); h.advance(10 * 60_000); await h.tracker.pulse();
  assert.equal(h.sends.length, 1);
  h.tracker.foreground(); await tick();
  assert.equal(h.sends.length, 2);
  assert.equal(h.sends[1].sessionId, h.sends[0].sessionId, 'short resume preserves session');
  assert.equal(h.sends[1].visitorId, h.sends[0].visitorId);
});

test('long background resumes rotate the session while a Saudi midnight heartbeat retains the install', async () => {
  const h = harness(); h.tracker.foreground(); await tick();
  h.tracker.background(); h.advance(usageSessionIdleMs); h.tracker.foreground(); await tick();
  assert.notEqual(h.sends[1].sessionId, h.sends[0].sessionId);
  h.at('2026-11-07T20:59:30Z'); await h.tracker.pulse();
  h.at('2026-11-07T21:00:10Z'); await h.tracker.pulse();
  assert.equal(h.sends.length, 4, 'new Saudi day bypasses heartbeat throttle');
  assert.equal(h.sends[3].sessionId, h.sends[1].sessionId);
  assert.equal(h.sends[3].visitorId, 'saved-installation-000001');
});

test('failed requests retry with the same receipt and storage failure never emits ephemeral identities', async () => {
  const h = harness(); h.fail(); h.tracker.foreground(); await tick();
  h.advance(60_000); await h.tracker.pulse();
  assert.equal(h.sends.length, 2);
  assert.deepEqual(h.sends[0], h.sends[1]);
  const unavailable = harness(); unavailable.failStorage(); unavailable.tracker.foreground(); await tick();
  assert.equal(unavailable.sends.length, 0);
});
