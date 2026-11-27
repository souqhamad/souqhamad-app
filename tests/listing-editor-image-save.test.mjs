import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import ts from 'typescript';
import { QueryClient } from '@tanstack/react-query';
import { runImageUploadBatch } from '../src/core/image-upload-batch.ts';
import { syncListingImageCaches } from '../src/core/listing-image-cache.ts';

test('editing sends explicit clearing while a new draft still omits unfilled optional fields', () => {
  const source = ts.createSourceFile('screen.tsx', fs.readFileSync(new URL('../src/features/listing-editor/screen.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = source.statements.filter(node => ts.isFunctionDeclaration(node) && ['normalizeNumber', 'buildListingBody'].includes(node.name?.text));
  const code = ts.transpileModule(functions.map(node => node.getText(source)).join('\n') + '\nglobalThis.body = buildListingBody;', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = vm.createContext({ exports: {} }); vm.runInContext(code, context);
  const form = { title: 'Edited listing', category: 'other', description: '', city: '', priceMode: 'amount', amount: '', categoryOption: '', carModel: '', year: '', mileage: '', condition: 'used' };
  const edit = JSON.parse(JSON.stringify(context.body(form, { category: 'other', attributes: {} })));
  assert.equal(edit.description, null); assert.equal(edit.city, null); assert.equal(edit.price, null);
  const create = JSON.parse(JSON.stringify(context.body(form, null)));
  assert.equal('description' in create, false); assert.equal('city' in create, false); assert.equal('price' in create, false);
  assert.equal(context.body({ ...form, description: 'Kept', city: 'Riyadh', amount: '١٢٣' }, null).price, 123);
});

// Execute the real editor mutation, with only device/UI and HTTP boundaries
// replaced. In particular, do not invoke onSuccess after the second upload fails.
function saveMutation(bindings, name = 'save', propertyName = 'mutationFn') {
  const source = ts.createSourceFile('screen.tsx', fs.readFileSync(new URL('../src/features/listing-editor/screen.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let save;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) save = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  const properties = save.initializer.arguments[0].properties;
  const mutation = properties.find(property => property.name?.getText(source) === propertyName).initializer;
  const code = ts.transpileModule(`globalThis.run = ${mutation.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = vm.createContext({
    imageRevision: { current: 0 }, imageActionsPending: { current: 0 },
    setLocalImagePreviews() {},
    backgroundUploadRunning: { current: false }, backgroundUploadBusy: false, imagePreparationPending: false,
    runImageUploadBatch, setUploadStages() {}, setImageMutationBusy() {}, imageRecovery: { current: null }, ...bindings,
    imageUploads: { getUploadId: () => undefined, ...bindings.imageUploads },
  });
  vm.runInContext(code, context);
  return context.run;
}

test('a later upload failure preserves the earlier photo in detail cache and leaves failed assets retryable', async () => {
  const queryClient = new QueryClient();
  const initial = { id: 'partial-upload-listing', sellerId: 'owner', status: 'published', images: [] };
  const saved = { ...initial, images: [{ id: 'saved-photo', status: 'approved', isPrimary: true }] };
  queryClient.setQueryData(['listing', initial.id], { listing: initial });
  const queue = [{ uri: 'photo-one' }, { uri: 'photo-two' }];
  let remaining = queue;
  let uploads = 0;
  const mutation = saveMutation({
    listing: initial, assets: queue, queryClient, syncListingImageCaches,
    validate() {}, categorySuggestion: { cancel() {} }, body: () => ({}),
    alive: { current: true }, setListing() {}, setAssets: update => { remaining = update(remaining); },
    uploadKeys: { current: new Map() }, Crypto: { randomUUID },
    bootstrap: { data: {} },
    imageUploads: {
      uploadListingImage: async () => { if (++uploads === 1) return { listing: saved }; throw new Error('503 storage unavailable'); },
    },
    api: {
      patch: async () => ({ listing: initial }),
      get: async () => { throw new Error('Must not hide a failed upload with a final refresh'); },
    },
  });
  try {
    await assert.rejects(mutation(false), /503 storage unavailable/);
    assert.equal(uploads, 2);
    assert.deepEqual(remaining, [queue[1]]);
    assert.deepEqual(queryClient.getQueryData(['listing', initial.id]).listing.images, saved.images);
  } finally { queryClient.clear(); }
});

test('direct saving keeps the chosen asset queued until its authoritative image is ready', async () => {
  const queryClient = new QueryClient();
  const initial = { id: 'await-ready-listing', sellerId: 'owner', status: 'draft', images: [] };
  const saved = { ...initial, images: [{ id: 'final-photo', status: 'approved', isPrimary: true }] };
  const queue = [{ uri: 'photo-one' }];
  let remaining = queue, complete;
  let previews = new Map();
  const processing = new Promise(resolve => { complete = resolve; });
  const calls = [];
  const bindings = {
    listing: initial, assets: queue, queryClient, syncListingImageCaches,
    validate() {}, categorySuggestion: { cancel() {} }, body: () => ({}),
    alive: { current: true }, setListing() {}, setAssets: update => { remaining = update(remaining); },
    setLocalImagePreviews: update => { previews = update(previews); },
    uploadKeys: { current: new Map() }, Crypto: { randomUUID },
    bootstrap: { data: { imageUploads: { protocol: 'r2-direct-v1', enabled: true } } },
    recoveredImages: { uploads: [], loading: false, error: null },
    imageUploads: { uploadListingImage: async (_id, _asset, options) => {
      assert.equal(options.capability.enabled, true);
      calls.push('processing'); return processing;
    } },
    api: {
      patch: async (_path, body) => { calls.push(body.action || 'save'); return { listing: initial }; },
      get: async () => ({ listing: saved }),
    },
  };
  const save = saveMutation(bindings);
  try {
    const pending = save(false);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.deepEqual(calls, ['save', 'processing']);
    assert.deepEqual(remaining, queue);
    assert.equal(queryClient.getQueryData(['owned-listing', initial.sellerId, initial.id]), undefined);
    complete({ listing: saved });
    await pending;
    assert.deepEqual(calls, ['save', 'processing']);
    assert.deepEqual(remaining, []);
    assert.equal(previews.get('final-photo'), 'photo-one', 'The local photo must survive successful upload queue removal');
    assert.deepEqual(queryClient.getQueryData(['owned-listing', initial.sellerId, initial.id]).listing.images, saved.images);
  } finally { queryClient.clear(); }
});

test('recovered server uploads block publication before saving or posting any action', async () => {
  for (const recoveredImages of [
    { uploads: [{ id: 'old-pending-upload' }], loading: false, error: null },
    { uploads: [], loading: true, error: null },
    { uploads: [], loading: false, error: new Error('offline') },
  ]) {
    let actions = 0;
    const publish = saveMutation({ validate() {}, recoveredImages,
      save: { mutateAsync: async () => { actions++; } }, api: { patch: async () => { actions++; } },
    }, 'publish');
    await assert.rejects(publish(), /الصور المنتظرة|تجهيز الصور/);
    assert.equal(actions, 0);
  }
});


test('a ready photo enters the detail cache immediately while another photo still processes', async () => {
  const client = new QueryClient();
  const initial = { id: 'progressive-listing', sellerId: 'owner', status: 'published', images: [] };
  const queues = [{ uri: 'first' }, { uri: 'second' }];
  const first = { ...initial, images: [{ id: 'one', status: 'approved', isPrimary: true }] };
  const all = { ...initial, images: [...first.images, { id: 'two', status: 'approved' }] };
  let resolveSecond, remaining = queues, settled = false;
  const second = new Promise(resolve => { resolveSecond = resolve; });
  const mutation = saveMutation({
    listing: initial, assets: queues, queryClient: client, syncListingImageCaches,
    validate() {}, categorySuggestion: { cancel() {} }, body: () => ({}), alive: { current: true },
    setListing() {}, setAssets: update => { remaining = update(remaining); },
    uploadKeys: { current: new Map() }, Crypto: { randomUUID },
    bootstrap: { data: { imageUploads: { protocol: 'r2-direct-v1', enabled: true } } },
    imageUploads: { uploadListingImage: async (_id, asset, options) => {
      options.onTransferred();
      return asset.uri === 'first' ? { listing: first } : second;
    } },
    api: { patch: async () => ({ listing: initial }), get: async () => ({ listing: all }) },
  });
  const pending = mutation(false).then(() => { settled = true; });
  try {
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.equal(settled, false);
    assert.deepEqual(client.getQueryData(['listing', initial.id]).listing.images, first.images);
    assert.deepEqual(remaining, [queues[1]]);
    resolveSecond({ listing: all });
    await pending;
    assert.deepEqual(client.getQueryData(['listing', initial.id]).listing.images, all.images);
    assert.deepEqual(remaining, []);
  } finally { client.clear(); }
});

test('settling a failed save requests fresh recovery ownership without reopening the editor', () => {
  let epoch = 3;
  const settled = saveMutation({ alive: { current: true }, setImageRecoveryEpoch: update => { epoch = update(epoch); } }, 'save', 'onSettled');
  settled();
  assert.equal(epoch, 4);
});

test('newly saved drafts enable recovery using their actual saved ID and replace duplicate local previews', () => {
  const source = ts.createSourceFile('screen.tsx', fs.readFileSync(new URL('../src/features/listing-editor/screen.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const variables = new Map(); let effect;
  const visit = node => {
    if (ts.isVariableDeclaration(node)) variables.set(node.name.getText(source), node);
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes('new ListingImageUploadRecovery')) effect = node.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(source);
  const draft = { id: 'new-draft-id', sellerId: 'owner', status: 'draft', title: 'working title', images: [] };
  let current = draft, assets = [{ uri: 'already-ready' }, { uri: 'still-pending' }], options, started = false, stopped = false;
  let previews = new Map();
  const context = vm.createContext({
    listing: draft, listingId: undefined, focused: true, imageMutationBusy: false, backgroundUploadBusy: false, imageUploadProtocol: 'r2-direct-v1', directUploadsEnabled: true,
    imageUploads: { getActiveUploadIds: () => new Set(), getUploadId: uri => uri === 'already-ready' ? 'ready-id' : 'pending-id' },
    imageRevision: { current: 0 }, alive: { current: true }, imageRecovery: { current: null },
    assetsRef: { current: assets }, setLocalImagePreviews: update => { previews = update(previews); },
    setRecoveredImages() {}, setListing: update => { current = update(current); },
    setAssets: update => { assets = update(assets); }, setUploadStages() {},
    mergeRecoveredListingImages: (previous, fresh) => ({ ...previous, images: fresh.images }),
    syncListingImageCaches() {}, queryClient: {},
    ListingImageUploadRecovery: class {
      constructor(value) { options = value; }
      start() { started = true; }
      stop() { stopped = true; }
    },
  });
  const code = ['recoveryListingId', 'canRecoverImages'].map(name => `const ${variables.get(name).getText(source)};`).join('\n') + `\nglobalThis.cleanup = (${effect.getText(source)})();`;
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  assert.equal(started, true);
  assert.equal(options.listingId, draft.id);
  options.onImages({ ...draft, title: 'server title', images: [{ id: 'ready-id' }] });
  assert.equal(current.title, 'working title');
  assert.equal(current.images.length, 1);
  assert.deepEqual(assets.map(asset => asset.uri), ['still-pending']);
  assert.equal(previews.get('ready-id'), 'already-ready', 'Recovery must keep the local preview after retiring its upload tile');
  context.cleanup();
  assert.equal(stopped, true);
  started = false;
  context.imageMutationBusy = true;
  vm.runInContext(ts.transpileModule(`(${effect.getText(source)})();`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  assert.equal(started, false, 'local saves and publication retain exclusive snapshot ownership');
});


test('successful save for publication keeps recovery paused until publish settles', () => {
  let busy = true, epoch = 0;
  const bindings = { alive: { current: true }, setImageMutationBusy: value => { busy = value; },
    setImageRecoveryEpoch: update => { epoch = update(epoch); } };
  const saved = saveMutation(bindings, 'save', 'onSettled');
  saved({}, null, true);
  assert.equal(busy, true);
  assert.equal(epoch, 0);
  const published = saveMutation(bindings, 'publish', 'onSettled');
  published();
  assert.equal(busy, false);
  assert.equal(epoch, 1);
});

test('publication handoff immediately navigates to my listings without announcing completed publication', async () => {
  const submitted = [], navigation = [];
  const assets = [{ uri: 'local-photo' }], uploadKeys = new Map([['local-photo', 'stable-image-key']]);
  const publish = saveMutation({ validate() {}, recoveredImages: { uploads: [], loading: false, error: null },
    categorySuggestion: { cancel() {} }, createKey: { current: 'stable-create-key' }, ownerId: 'owner',
    listing: null, body: () => ({ title: 'selected title' }), assets, uploadKeys: { current: uploadKeys },
    coordinator: { enqueue: input => { submitted.push(input); return input.id; } },
  }, 'publish');
  const success = saveMutation({ alive: { current: true }, setPreview() {},
    router: { replace: path => navigation.push(path) },
    feedback: { alert() { throw new Error('handoff_is_not_successful_publication'); } },
  }, 'publish', 'onSuccess');
  assert.equal(await publish(), 'stable-create-key');
  success();
  assert.deepEqual(navigation, ['/(tabs)/listings']);
  assert.equal(submitted[0].assets, assets);
  assert.equal(submitted[0].uploadKeys, uploadKeys);
  assert.equal(submitted[0].ownerId, 'owner');
});

test('a handed-off local photo consumes one display slot while every pending job still blocks publication', () => {
  const source = ts.createSourceFile('screen.tsx', fs.readFileSync(new URL('../src/features/listing-editor/screen.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  const visit = node => { if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'visibleRecoveredImages') declaration = node; ts.forEachChild(node, visit); };
  visit(source);
  const state = { uploads: [{ id: 'local-job' }, { id: 'restored-job' }] };
  const context = vm.createContext({ recoveredImages: state, assets: [{ uri: 'local' }], imageUploads: { getUploadId: () => 'local-job' } });
  const code = ts.transpileModule(`globalThis.visible = ${declaration.initializer.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInContext(code, context);
  assert.deepEqual(Array.from(context.visible, upload => upload.id), ['restored-job']);
  assert.equal(state.uploads.length, 2);
});
