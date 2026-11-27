const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function load() {
  const filename = path.resolve(__dirname, '../src/core/ai-consent.ts');
  const module = { exports: {} };
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(output, { module, exports: module.exports, require: name => {
    if (name === 'react') return {};
    if (name === 'react-native') return { Alert: {}, Platform: { OS: 'android' } };
    if (name === 'expo-secure-store' || name === './api' || name === './bootstrap') return {};
    throw Error(`Unexpected dependency ${name}`);
  } }, { filename });
  return module.exports;
}
const scope = { key: 'fixture-owner-a', ownerId: 'owner-a', version: 'consent-v1' };
function harness(overrides = {}) {
  let identity = 'owner-a';
  let prompts = 0;
  const saved = new Map();
  const { createAiConsentSession } = load();
  const session = createAiConsentSession({
    now: () => 100000,
    read: async key => saved.get(key) ?? null,
    write: async (key, value) => { saved.set(key, value); },
    remove: async key => { saved.delete(key); },
    choose: async () => { prompts++; return true; },
    identity: () => { const expected = identity; return () => { if (expected !== identity) throw Error('account changed'); }; },
    ...overrides,
  });
  return { session, saved, prompts: () => prompts, switchAccount: value => { identity = value; } };
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('Hamad disclosure stays provider-neutral with a current or older server', () => {
  const { resolveAiConsentDisclosure, aiConsentVersion } = load();
  const local = resolveAiConsentDisclosure();
  assert.equal(local.version, aiConsentVersion);
  assert.match(local.description, /في محادثة حمد/);
  assert.match(local.description, /خدمة خارجية للذكاء الاصطناعي/);
  const legacyVersion = 'deepseek-sharing-2026-11-02-v1';
  const legacy = resolveAiConsentDisclosure({ version: legacyVersion, description: 'DeepSeek واقتراح التصنيف' });
  assert.equal(legacy.version, legacyVersion);
  assert.equal(legacy.description, local.description);
  assert.doesNotMatch(legacy.description, /deepseek|ديب\s*سيك|اقتراح التصنيف/i);
  const updated = { version: 'future-disclosure', description: 'شرح محدث للمشاركة في محادثة حمد.' };
  assert.deepEqual(JSON.parse(JSON.stringify(resolveAiConsentDisclosure(updated))), updated);
});

test('no consent is assumed; declining never saves or enables AI', async () => {
  const h = harness({ choose: async () => false });
  await h.session.load(scope);
  assert.equal(h.session.has(scope), false);
  assert.equal(await h.session.request(scope, 'explanation'), false);
  assert.equal(h.saved.size, 0);
  assert.equal(h.session.has(scope), false);
});

test('a single affirmative dialog serves concurrent requests and saves only its account/version', async () => {
  const choice = deferred();
  let prompts = 0;
  const h = harness({ choose: () => { prompts++; return choice.promise; } });
  const first = h.session.request(scope, 'explanation');
  const second = h.session.request(scope, 'explanation');
  assert.equal(first, second);
  assert.equal(prompts, 1);
  assert.equal(h.session.has(scope), false);
  choice.resolve(true);
  assert.equal(await first, true);
  assert.equal(h.session.has(scope), true);
  assert.equal(h.session.has({ ...scope, version: 'consent-v2' }), false);
  assert.equal(h.session.has({ ...scope, key: 'fixture-owner-b', ownerId: 'owner-b' }), false);
  assert.deepEqual(JSON.parse(h.saved.get(scope.key)), { ownerId: 'owner-a', version: 'consent-v1', acceptedAt: 100000 });
});

test('switching account while the dialog is open rejects approval without persistence', async () => {
  const choice = deferred();
  const h = harness({ choose: () => choice.promise });
  const request = h.session.request(scope, 'explanation');
  h.switchAccount('owner-b'); choice.resolve(true);
  assert.equal(await request, false);
  assert.equal(h.saved.size, 0);
  assert.equal(h.session.has(scope), false);
});

test('late hydration cannot undo withdrawal or a newer affirmative receipt', async () => {
  const oldReceipt = JSON.stringify({ ownerId: scope.ownerId, version: scope.version, acceptedAt: 99999 });
  const read = deferred();
  const h = harness({ read: () => read.promise });
  const load = h.session.load(scope);
  await h.session.revoke(scope);
  read.resolve(oldReceipt); await load;
  assert.equal(h.session.has(scope), false);
  assert.equal(await h.session.request(scope, 'explanation'), true);
  assert.equal(h.session.has(scope), true);
});

test('a late stored receipt cannot override declining the current disclosure', async () => {
  const read = deferred();
  const h = harness({ read: () => read.promise, choose: async () => false });
  const loading = h.session.load(scope);
  assert.equal(await h.session.request(scope, 'explanation'), false);
  read.resolve(JSON.stringify({ ownerId: scope.ownerId, version: scope.version, acceptedAt: 99999 }));
  await loading;
  assert.equal(h.session.has(scope), false);
});

test('withdrawal during a pending save completes after it and removes its receipt', async () => {
  const saving = deferred();
  const operations = [];
  const h = harness({
    write: async () => { operations.push('save:start'); await saving.promise; operations.push('save:end'); },
    remove: async () => { operations.push('remove'); },
  });
  const request = h.session.request(scope, 'explanation'); await settle();
  assert.deepEqual(operations, ['save:start']);
  const revocation = h.session.revoke(scope); await settle();
  assert.deepEqual(operations, ['save:start']);
  saving.resolve();
  assert.equal(await request, false);
  await revocation;
  assert.deepEqual(operations, ['save:start', 'save:end', 'remove']);
  assert.equal(h.session.has(scope), false);
});

test('withdrawal invalidates an already open approval dialog', async () => {
  const choice = deferred();
  const h = harness({ choose: () => choice.promise });
  const request = h.session.request(scope, 'explanation');
  await h.session.revoke(scope); choice.resolve(true);
  assert.equal(await request, false);
  assert.equal(h.saved.size, 0);
});

test('mounting another screen while withdrawal deletes storage cannot hydrate the old receipt', async () => {
  const removing = deferred();
  const oldReceipt = JSON.stringify({ ownerId: scope.ownerId, version: scope.version, acceptedAt: 99999 });
  const h = harness({ read: async () => oldReceipt, remove: () => removing.promise });
  await h.session.load(scope);
  assert.equal(h.session.has(scope), true);
  const revoking = h.session.revoke(scope);
  await h.session.load(scope);
  assert.equal(h.session.has(scope), false);
  removing.resolve(); await revoking;
});

test('tampered, expired, future or differently scoped receipts require a new choice', async () => {
  for (const value of [
    'invalid-json',
    JSON.stringify({ ownerId: 'owner-b', version: scope.version, acceptedAt: 99999 }),
    JSON.stringify({ ownerId: scope.ownerId, version: 'old-version', acceptedAt: 99999 }),
    JSON.stringify({ ownerId: scope.ownerId, version: scope.version, acceptedAt: 100001 }),
    JSON.stringify({ ownerId: scope.ownerId, version: scope.version, acceptedAt: -365 * 86400000 }),
  ]) {
    const h = harness({ read: async () => value });
    await h.session.load(scope);
    assert.equal(h.session.has(scope), false);
  }
});

test('a secure storage failure never grants consent', async () => {
  const h = harness({ write: async () => { throw Error('unavailable'); } });
  assert.equal(await h.session.request(scope, 'explanation'), false);
  assert.equal(h.session.has(scope), false);
});
