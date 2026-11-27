const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function execute(file, imports) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/features/assistant', file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, Date,
    require: name => { assert.ok(Object.hasOwn(imports, name), name); return imports[name]; },
  });
  return module.exports;
}

const choice = 'كيف تفضّل إنشاء إعلانك؟ اختر الإنشاء مع حمد لتجهيز مسودة بالمحادثة، أو الإنشاء اليدوي لإدخال البيانات بنفسك.';
const message = (text, fields = {}) => ({ id: 'message', role: 'assistant', parts: [{ type: 'text', text }], ...fields });

function history({ failWrite = () => false } = {}) {
  const storage = new Map();
  const context = execute('context.ts', {});
  const drafts = execute('drafts.ts', {});
  const origin = 'https://fixture.example.test';
  const key = owner => 'hamad.history.' + crypto.createHash('sha256').update(`${origin}:${owner}`).digest('hex');
  const api = execute('history.ts', {
    './context': context,
    './drafts': drafts,
    '../../core/api': { getApiBaseUrl: () => origin },
    'expo-crypto': { CryptoDigestAlgorithm: { SHA256: 'sha256' },
      digestStringAsync: async (_algorithm, text) => crypto.createHash('sha256').update(text).digest('hex') },
    'expo-secure-store': { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device',
      getItemAsync: async name => storage.get(name) ?? null,
      setItemAsync: async (name, value) => {
        if (failWrite(name)) throw new Error('interrupted write');
        storage.set(name, value);
      },
      deleteItemAsync: async name => storage.delete(name) },
  });
  return { ...api, ...context, ...drafts, storage, key };
}

test('saving and reopening a choice preserves its safe marker while excluding photos and other metadata', async () => {
  const h = history();
  await h.writeAssistantHistory('owner-a', {
    conversationId: 'conversation-owner-a', creationMethod: true,
    messages: [message('اختر طريقة الإنشاء', { metadata: { creationChoice: true, secret: 'never-store-metadata' },
      parts: [{ type: 'text', text: 'اختر طريقة الإنشاء' }, { type: 'file', mediaType: 'image/jpeg', url: 'never-store-photo' }] })],
  });
  const saved = await h.readAssistantHistory('owner-a');
  assert.equal(saved.creationMethod, true);
  assert.equal(h.isCreationChoiceMessage(saved.messages[0]), true);
  assert.equal(JSON.stringify(saved.messages[0].metadata), JSON.stringify({ creationChoice: true }));
  assert.equal(saved.messages[0].parts.length, 1);
  assert.ok(![...h.storage.values()].join('').includes('never-store-'));
  assert.equal(await h.readAssistantHistory('owner-b'), null);
});

test('an older text-only saved choice is recognized on read without losing the conversation or selection', async () => {
  const h = history();
  const key = h.key('owner-a');
  h.storage.set(key, JSON.stringify({ chunks: 1, updatedAt: Date.now() }));
  h.storage.set(key + '.0', JSON.stringify({ conversationId: 'conversation-owner-a', creationMethod: true,
    messages: [message(choice.replace('تفضّل', 'تفضل').replace('؟ ', '؟\n'))] }));
  const saved = await h.readAssistantHistory('owner-a');
  assert.equal(saved.conversationId, 'conversation-owner-a');
  assert.equal(saved.creationMethod, true);
  assert.equal(h.isCreationChoiceMessage(saved.messages[0]), true);
  assert.equal(saved.messages[0].metadata.creationChoice, true);
});

test('method help and user quotations remain ordinary history messages', () => {
  const { isCreationChoiceMessage } = history();
  assert.equal(isCreationChoiceMessage(message('يمكنك الإنشاء مع حمد أو الإنشاء اليدوي من الصفحة الرئيسية.')), false);
  assert.equal(isCreationChoiceMessage(message(choice, { role: 'user' })), false);
  assert.equal(isCreationChoiceMessage(message('تفاصيل الإعلان محفوظة.')), false);
});

test('a reopened chat keeps its latest draft checkpoint and survives an interrupted snapshot write', async () => {
  let interrupted = false;
  const h = history({ failWrite: name => interrupted && name === h.key('owner-a') });
  const memory = 'checkpoint.' + 'a'.repeat(43);
  const state = {
    conversationId: 'conversation-owner-a',
    creationMethod: true,
    messages: [
      message('سؤال سابق', { id: 'old', metadata: { hamadDraftMemory: 'earlier.' + 'b'.repeat(43) } }),
      message('وش تبي يكون سعر المكتب؟', { id: 'recent', metadata: { hamadDraftMemory: memory } }),
    ],
  };
  await h.writeAssistantHistory('owner-a', state);
  interrupted = true;
  await assert.rejects(h.writeAssistantHistory('owner-a', { ...state, messages: [message('محادثة أخرى')] }), /interrupted write/);
  const reopened = await h.readAssistantHistory('owner-a');
  assert.equal(reopened.messages[0].metadata, undefined);
  assert.equal(reopened.messages[1].metadata.hamadDraftMemory, memory);
  assert.equal(await h.readAssistantHistory('owner-b'), null);
  interrupted = false;
  await h.clearAssistantHistory('owner-a');
  assert.equal(await h.readAssistantHistory('owner-a'), null);
  assert.ok(![...h.storage.keys()].some(key => key.startsWith(h.key('owner-a'))));
});

test('only the active draft label and signed memory survive a reopen and display data stays off the request', async () => {
  const h = history();
  const memory = 'h2_fixture.' + 'a'.repeat(43);
  const card = { title: 'مسودة الجوال', modified: '2026-11-23T08:00:00Z', price: 450, imageCount: 1,
    thumbnail: 'https://cdn.example.test/never-store-thumbnail' };
  const active = { title: card.title, expires: Date.now() + 300_000 };
  const dialog = [
    message('أرني المسودة المختارة', { id: 'customer', role: 'user' }),
    message('تم اختيار المسودة', { id: 'selected', metadata: { hamadDraftMemory: memory,
      hamadDraftUi: { active, preview: { ...card, description: 'never-store-preview' } } } }),
  ];
  assert.equal(h.readHamadDraftUi(dialog[1].metadata).preview.price, 450);
  assert.equal(h.selectAssistantContext(dialog)[1].metadata.hamadDraftMemory, memory);
  assert.equal(h.selectAssistantContext(dialog)[1].metadata.hamadDraftUi, undefined);
  await h.writeAssistantHistory('owner-a', { conversationId: 'conversation-owner-a', creationMethod: false, messages: dialog });
  const saved = await h.readAssistantHistory('owner-a');
  assert.equal(h.readHamadDraftUi(saved.messages[1].metadata).active.title, 'مسودة الجوال');
  assert.equal(h.readHamadDraftUi(saved.messages[1].metadata).preview, undefined);
  assert.ok(![...h.storage.values()].join('').includes('never-store'));
  assert.equal(await h.readAssistantHistory('owner-b'), null);
});

test('draft cards accept only a bounded list and preserve text fallback for malformed or old replies', () => {
  const { readHamadDraftUi } = history();
  const card = { title: 'مسودة', modified: '2026-11-23T08:00:00Z', price: 'bid', imageCount: 0 };
  const page = { key: 'a'.repeat(64) + ':0', cards: [card], hasNext: true };
  assert.equal(readHamadDraftUi({ hamadDraftUi: { page } }).page.cards[0].price, 'bid');
  assert.equal(readHamadDraftUi({ hamadDraftUi: { page: { ...page, cards: Array(5).fill(card) } } }).page, undefined);
  assert.equal(readHamadDraftUi({ hamadDraftUi: { page: { ...page, key: 'draft-record-id' } } }).page, undefined);
  assert.equal(readHamadDraftUi({ creationChoice: true }).page, undefined);
});
