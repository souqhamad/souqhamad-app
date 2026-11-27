const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Execute the screen's actual handlers, with only the dialog and transport
// isolated. This catches clearing an attachment before consent or losing its
// consent header when the AI SDK prepares the final request.
const filename = path.resolve(__dirname, '../src/features/assistant/screen.tsx');
const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let send, prepare;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'send') send = node.initializer;
  if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'prepareSendMessagesRequest') prepare = node.initializer;
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(send && prepare);
const javascript = ts.transpileModule(`module.exports = { send: ${send.getText(source)}, prepare: ${prepare.getText(source)} };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function harness(listingEntry = false) {
  let token = 'owner-a';
  let text = 'إعلان جديد';
  let assets = [{ name: 'photo.jpg', dataUrl: 'data:image/jpeg;base64,YQ==' }];
  let creation = false;
  const consent = deferred();
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(javascript, {
    module, busy: false, ready: true, picking: false,
    attachments: assets, sendPending: { current: false }, mounted: { current: true }, tokenAtMount: { current: token },
    getSessionToken: () => token, aiConsent: { request: () => consent.promise, version: 'consent-v1' },
    aiConsentHeader: 'x-souq-hamad-ai-consent',
    feedback: { warning: () => {} }, creationRef: { current: false }, setCreation: value => { creation = value; },
    setText: value => { text = value; }, setAttachments: value => { assets = value; },
    sendMessage: async (...args) => { calls.push(args); },
    listingEntry, isCreationChoiceMessage: message => message.metadata?.creationChoice === true,
    selectAssistantContext: messages => messages, retained: { current: { source: null, files: [] } },
    ownerId: 'owner-a', conversationId: { current: 'conversation-a' },
  }, { filename });
  return { ...module.exports, consent, calls, state: () => ({ text, assets, creation }), switchAccount: () => { token = 'owner-b'; } };
}

test('waiting for or declining consent retains the message and attachments without a request', async () => {
  const h = harness(true);
  const pending = h.send('إعلان جديد');
  assert.equal(h.state().text, 'إعلان جديد');
  assert.equal(h.state().assets.length, 1);
  assert.equal(h.calls.length, 0);
  assert.equal(h.state().creation, false);
  h.consent.resolve(false); await pending;
  assert.equal(h.state().assets.length, 1);
  assert.equal(h.calls.length, 0);
});

test('rapid send taps share one operation and only the approved request clears the composer', async () => {
  const h = harness();
  const first = h.send('إعلان جديد');
  const second = h.send('إعلان جديد');
  h.consent.resolve(true); await Promise.all([first, second]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.state().text, '');
  assert.equal(h.state().assets.length, 0);
  assert.equal(h.calls[0][1].headers['x-souq-hamad-ai-consent'], 'consent-v1');
  assert.equal(h.calls[0][0].files.length, 1);
});

test('an account change during consent prevents sending and clearing old account input', async () => {
  const h = harness();
  const request = h.send('إعلان جديد');
  h.switchAccount(); h.consent.resolve(true); await request;
  assert.equal(h.calls.length, 0);
  assert.equal(h.state().text, 'إعلان جديد');
  assert.equal(h.state().assets.length, 1);
});

test('the prepared Hamad transport preserves consent headers together with verified bearer ownership', () => {
  const h = harness();
  const prepared = h.prepare({ messages: [], body: {}, headers: { 'x-souq-hamad-ai-consent': 'consent-v1' } });
  assert.equal(prepared.headers['x-souq-hamad-ai-consent'], 'consent-v1');
  assert.equal(prepared.headers.Authorization, 'Bearer owner-a');
  assert.equal(prepared.body.chatOwnerId, 'owner-a');
  assert.equal(prepared.body.creationMethod, undefined);
});

test('dedicated entry preserves the saved conversation and images while skipping an obsolete method prompt', async () => {
  const h = harness(true);
  const send = h.send('آيفون مستعمل');
  h.consent.resolve(true);
  await send;
  const [{ text, files }, options] = h.calls[0];
  assert.equal(h.state().creation, true);
  const prepared = h.prepare({
    messages: [
      { id: 'previous-user', role: 'user', parts: [{ type: 'text', text: 'أريد تجهيز إعلان' }] },
      { id: 'old-choice', role: 'assistant', metadata: { creationChoice: true }, parts: [{ type: 'text', text: 'اختر طريقة الإنشاء' }] },
      { id: 'first-details', role: 'user', parts: [{ type: 'text', text }, ...files] },
    ],
    ...options,
  });
  assert.equal(prepared.body.creationMethod, 'chat');
  assert.equal(prepared.body.beginDraftWithHamad, undefined);
  assert.equal(prepared.body.chatConversationId, 'conversation-a');
  assert.equal(prepared.body.messages.map(message => message.id).join(','), 'previous-user,first-details');
  assert.equal(prepared.body.messages.at(-1).parts[0].text, 'آيفون مستعمل');
  assert.equal(prepared.body.messages.at(-1).parts[1].url, 'data:image/jpeg;base64,YQ==');
});

test('selecting Hamad within general chat removes the earlier choice from subsequent requests', async () => {
  const h = harness();
  const send = h.send('أختار الإنشاء مع حمد.', true);
  h.consent.resolve(true);
  await send;
  const prepared = h.prepare({ messages: [
    { id: 'details', role: 'user', parts: [{ type: 'text', text: 'هاتف مستعمل' }] },
    { id: 'choice', role: 'assistant', metadata: { creationChoice: true }, parts: [{ type: 'text', text: 'اختر طريقة الإنشاء' }] },
    { id: 'selected', role: 'user', parts: [{ type: 'text', text: h.calls[0][0].text }] },
  ], ...h.calls[0][1] });
  assert.equal(prepared.body.creationMethod, 'chat');
  assert.equal(prepared.body.beginDraftWithHamad, true);
  assert.equal(prepared.body.messages.map(message => message.id).join(','), 'details,selected');
});
