const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
const ts = require("typescript");

function actualModule(relative, imports) {
  const filename = path.resolve(__dirname, "..", relative);
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: name => {
    assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name}`); return imports[name];
  }, Date, Map, Set, Promise, Error, encodeURIComponent, JSON });
  return module.exports;
}
const batch = actualModule("src/core/image-upload-batch.ts", {});
const { ListingPublicationCoordinator } = actualModule("src/core/listing-publication.ts", { "./image-upload-batch": batch });
const clone = value => JSON.parse(JSON.stringify(value));
function gate() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(predicate) {
  for (let index = 0; index < 300; index++) { if (predicate()) return; await Promise.resolve(); }
  assert.ok(predicate(), "The publication did not reach the expected phase");
}
function harness(options = {}) {
  let identity = { token: "account-a-token", generation: 0 };
  let listing = null;
  const journal = new Map(), requests = [], uploads = [], cached = [], completed = [], keys = new Map();
  const dependencies = {
    identity: () => identity,
    assertIdentity: expected => assert.deepEqual(expected, identity, "account_changed"),
    uuid: randomUUID,
    load: async owner => { await options.load?.(); return clone(journal.get(owner) ?? []); },
    store: async (owner, jobs) => { journal.set(owner, clone(jobs)); },
    keepPhoto: async (owner, id, index, asset) => {
      await options.keepPhoto?.(asset);
      return { ...asset, uri: `file:///private/${owner}/${id}/${index}.jpg` };
    },
    releasePhotos: async () => {},
    capability: () => ({ protocol: "r2-direct-v1", enabled: options.direct !== false }),
    client: () => {
      const ids = new Map(), currentKeys = new Map();
      return {
        getUploadId: uri => ids.get(uri),
        getUploadKey: uri => currentKeys.get(uri),
        uploadListingImage: async (id, asset, settings) => {
          uploads.push({ id, asset, key: settings.idempotencyKey });
          currentKeys.set(asset.uri, settings.idempotencyKey);
          settings.onTransferred();
          await options.upload?.(asset, settings, { listing, uploads, currentKeys });
          const imageId = `image-${currentKeys.get(asset.uri)}`;
          if (!listing.images.some(image => image.id === imageId)) listing.images.push({ id: imageId,
            listingId: listing.id, isPrimary: !listing.images.length, status: "approved",
            originalUrl: `https://images.invalid/${imageId}.webp`, displayUrl: `https://images.invalid/${imageId}.webp`, thumbnailUrl: `https://images.invalid/${imageId}-small.webp` });
          ids.set(asset.uri, imageId);
          return { listing: clone(listing) };
        },
      };
    },
    request: async (method, url, body, settings) => {
      assert.deepEqual(settings.expectedIdentity, identity);
      requests.push({ method, url, body, key: settings.idempotencyKey });
      if (method === "POST") {
        listing ??= { ...body, id: "saved-listing", sellerId: "account-a", images: [], status: "draft", createdAt: "2026-11-04T00:00:00.000Z", updatedAt: "2026-11-04T00:00:00.000Z" };
        keys.set(settings.idempotencyKey, listing.id);
      } else if (method === "PATCH" && body.action === "publish") listing.status = options.publicationStatus ?? "published";
      else if (method === "PATCH" && body.action === "set_primary") listing.images.forEach(image => { image.isPrimary = url.endsWith(image.id); });
      else if (method === "PATCH") listing = { ...listing, ...body };
      await options.request?.({ method, url, body, settings, listing, requests });
      return { listing: clone(listing) };
    },
    onListing: value => cached.push(clone(value)),
    onComplete: value => completed.push(clone(value)),
    errorText: error => error.message,
  };
  const coordinator = new ListingPublicationCoordinator(dependencies);
  coordinator.activate("account-a");
  const input = (photoCount = 2) => ({ id: randomUUID(), ownerId: "account-a", listing: null,
    body: { title: "كرسي", description: "كرسي خشبي", city: "الرياض", category: "furniture", price: 100, attributes: {} },
    assets: Array.from({ length: photoCount }, (_, index) => ({ uri: `file:///selected/${index}.jpg`, name: `${index}.jpg`, type: "image/jpeg" })), uploadKeys: new Map() });
  return { coordinator, dependencies, journal, requests, uploads, cached, completed, keys, input,
    switchAccount: owner => { identity = { token: `${owner}-token`, generation: identity.generation + 1 }; coordinator.activate(owner); },
    get listing() { return listing; } };
}

test("a handed-off publication keeps running without screen subscribers and announces success only after all photos and server publication", async () => {
  const processing = gate();
  const h = harness({ upload: asset => asset.name === "1.jpg" ? processing.promise : undefined });
  const unsubscribe = h.coordinator.subscribe(() => {});
  const input = h.input();
  await h.coordinator.enqueue(input);
  assert.equal(h.coordinator.getSnapshot()[0].listing.title, "كرسي");
  assert.equal(h.coordinator.getSnapshot()[0].serverId, undefined);
  assert.equal(h.coordinator.getSnapshot()[0].phase, "saving");
  unsubscribe();
  await until(() => h.coordinator.getSnapshot()[0].photos[0].readyId);
  assert.equal(h.completed.length, 0);
  assert.equal(h.requests.some(call => call.body?.action === "publish"), false);
  processing.resolve();
  await until(() => h.completed.length === 1);
  assert.equal(h.listing.images.length, 2);
  assert.equal(h.listing.status, "published");
  assert.ok(h.coordinator.getSnapshot()[0].photos.every(photo => photo.readyId));
  assert.equal(h.completed[0].status, "published");
});

test("duplicate handoffs and an ambiguous create response reuse one operation and stable create/upload/publish keys", async () => {
  let loseCreateResponse = true;
  const h = harness({ request: call => {
    if (call.method === "POST" && loseCreateResponse) { loseCreateResponse = false; throw new Error("lost acknowledgement"); }
  } });
  const input = h.input(1);
  assert.equal(await h.coordinator.enqueue(input), await h.coordinator.enqueue(input));
  await until(() => h.coordinator.getSnapshot()[0].phase === "failed");
  const before = clone(h.coordinator.getSnapshot()[0]);
  h.coordinator.retry(input.id);
  await until(() => h.completed.length === 1);
  const createCalls = h.requests.filter(call => call.method === "POST");
  assert.equal(createCalls.length, 2);
  assert.deepEqual(createCalls.map(call => call.key), [input.id, input.id]);
  assert.equal(h.keys.size, 1);
  assert.equal(h.uploads[0].key, before.photos[0].key);
  assert.equal(h.requests.find(call => call.body?.action === "publish").key, before.publishKey);
});

test("a later image failure keeps successful images and submitted input, and retry uploads only the remaining photo", async () => {
  let fail = true;
  const h = harness({ direct: false, upload: asset => {
    if (asset.name === "1.jpg" && fail) { fail = false; throw new Error("temporary image failure"); }
  } });
  const input = h.input();
  await h.coordinator.enqueue(input);
  await until(() => h.coordinator.getSnapshot()[0].phase === "failed");
  assert.ok(h.coordinator.getSnapshot()[0].photos[0].readyId);
  assert.equal(h.coordinator.getSnapshot()[0].photos[1].readyId, undefined);
  assert.equal(h.coordinator.getSnapshot()[0].body.description, input.body.description);
  assert.equal(h.requests.some(call => call.body?.action === "publish"), false);
  h.coordinator.retry(input.id);
  await until(() => h.completed.length === 1);
  assert.deepEqual(h.uploads.map(call => call.asset.name), ["0.jpg", "1.jpg", "1.jpg"]);
  assert.equal(h.uploads[1].key, h.uploads[2].key);
  assert.equal(h.requests.filter(call => call.method === "POST").length, 1);
});

test("reopening resumes the saved draft and retained image keys without repeating successful photos", async () => {
  const paused = gate(); let pause = true;
  const h = harness({ direct: false, upload: asset => asset.name === "1.jpg" && pause ? paused.promise : undefined });
  const input = h.input();
  await h.coordinator.enqueue(input);
  await until(() => h.uploads.length === 2 && h.journal.get("account-a")?.[0].photos[0].readyId);
  h.coordinator.activate(null); // Simulate losing the old JS owner before a new runtime restores the journal.
  pause = false;
  const restored = new ListingPublicationCoordinator(h.dependencies);
  restored.activate("account-a");
  await until(() => h.completed.length === 1);
  paused.resolve();
  assert.deepEqual(h.uploads.map(call => call.asset.name), ["0.jpg", "1.jpg", "1.jpg"]);
  assert.equal(h.uploads[1].key, h.uploads[2].key);
  assert.equal(h.requests.filter(call => call.method === "POST").length, 1);
  assert.equal(restored.getSnapshot()[0].phase, "complete");
});

test("an account switch blocks late save results, future publication and callbacks in the new account", async () => {
  const paused = gate();
  const h = harness({ request: call => call.method === "POST" ? paused.promise : undefined });
  await h.coordinator.enqueue(h.input(0));
  await until(() => h.requests.length === 1);
  h.switchAccount("account-b");
  paused.resolve();
  for (let index = 0; index < 100; index++) await Promise.resolve();
  assert.equal(h.cached.length, 0);
  assert.equal(h.completed.length, 0);
  assert.equal(h.requests.length, 1);
  assert.equal(h.coordinator.getSnapshot().length, 0);
});

test("a lost publish response reconciles the authoritative status instead of republishing or claiming premature success", async () => {
  let loseResponse = true;
  const h = harness({ request: call => {
    if (call.body?.action === "publish" && loseResponse) { loseResponse = false; throw new Error("lost publish acknowledgement"); }
  } });
  const input = h.input(0);
  await h.coordinator.enqueue(input);
  await until(() => h.coordinator.getSnapshot()[0].phase === "failed");
  assert.equal(h.listing.status, "published");
  assert.equal(h.completed.length, 0);
  h.coordinator.retry(input.id);
  await until(() => h.completed.length === 1);
  assert.equal(h.requests.filter(call => call.body?.action === "publish").length, 1);
});

test("a successful publication uses its committed response without requiring a second confirmation request", async () => {
  const h = harness({ request: call => {
    if (call.method === "GET" && call.listing.status === "published") throw new Error("unnecessary_confirmation_failed");
  } });
  await h.coordinator.enqueue(h.input(6));
  await until(() => h.completed.length === 1);
  assert.equal(h.completed[0].status, "published");
  assert.equal(h.completed[0].images.length, 6);
  assert.equal(h.requests.filter(call => call.method === "GET").length, 1);
  assert.equal(h.requests.filter(call => call.body?.action === "publish").length, 1);
});

for (const failure of [{ status: 0, code: "network" }, { status: 0, code: "aborted" }, { status: 503, code: "http_503" }]) {
  test(`an uncertain publication ${failure.code} is reconciled immediately without a second mutation`, async () => {
    const h = harness({ request: call => {
      if (call.body?.action === "publish") throw Object.assign(new Error("acknowledgement_lost"), failure);
    } });
    await h.coordinator.enqueue(h.input(2));
    await until(() => h.completed.length === 1);
    assert.equal(h.completed[0].status, "published");
    assert.equal(h.completed[0].images.length, 2);
    assert.equal(h.requests.filter(call => call.body?.action === "publish").length, 1);
  });
}

test("a transient publication failure with an unpublished server state remains retryable and cannot claim success", async () => {
  const h = harness({ request: call => {
    if (call.body?.action === "publish") {
      call.listing.status = "draft";
      throw Object.assign(new Error("server_temporarily_unavailable"), { status: 503, code: "http_503" });
    }
  } });
  await h.coordinator.enqueue(h.input(1));
  await until(() => h.coordinator.getSnapshot()[0].phase === "failed");
  assert.equal(h.completed.length, 0);
  assert.equal(h.listing.status, "draft");
  assert.equal(h.requests.filter(call => call.body?.action === "publish").length, 1);
});

test("server review remains review and a stale list does not remove the truthful local snapshot", async () => {
  const h = harness({ publicationStatus: "pending" });
  await h.coordinator.enqueue(h.input(1));
  await until(() => h.completed.length === 1);
  assert.equal(h.completed[0].status, "pending");
  const authoritative = clone(h.listing);
  h.coordinator.reconcile([{ ...authoritative, images: [] }]);
  assert.equal(h.coordinator.getSnapshot().length, 1);
  h.coordinator.reconcile([authoritative]);
  assert.equal(h.coordinator.getSnapshot().length, 0);
});

test("a renewed image reservation key is retained even when its current upload fails", async () => {
  let fail = true;
  const renewedKey = randomUUID();
  const h = harness({ upload: (asset, _settings, state) => {
    if (fail) { fail = false; state.currentKeys.set(asset.uri, renewedKey); throw new Error("response lost after renewal"); }
  } });
  const input = h.input(1);
  await h.coordinator.enqueue(input);
  await until(() => h.coordinator.getSnapshot()[0].phase === "failed");
  assert.equal(h.coordinator.getSnapshot()[0].photos[0].key, renewedKey);
  h.coordinator.retry(input.id);
  await until(() => h.completed.length === 1);
  assert.equal(h.uploads[1].key, renewedKey);
});

test("a missing required image in the final server response cannot trigger a successful publication callback", async () => {
  const h = harness({ request: call => {
    if (call.body?.action === "publish") call.listing.images = [];
  } });
  await h.coordinator.enqueue(h.input(1));
  await until(() => h.coordinator.getSnapshot()[0].phase === "failed");
  assert.equal(h.completed.length, 0);
});

test("a completed local card never masks a newer server edit or deletion", async () => {
  const h = harness();
  await h.coordinator.enqueue(h.input(1));
  await until(() => h.completed.length === 1);
  h.coordinator.reconcile([{ ...h.listing, title: "newer edit", status: "deleted", images: [], updatedAt: "2026-11-05T00:00:00.000Z" }]);
  assert.equal(h.coordinator.getSnapshot().length, 0);
});

test("editing a settled failed draft uses the new submitted fields and photos instead of retrying the obsolete snapshot", async () => {
  let fail = true;
  const h = harness({ upload: () => { if (fail) throw new Error("offline"); } });
  await h.coordinator.enqueue(h.input(1));
  await until(() => h.coordinator.getSnapshot()[0].phase === "failed");
  fail = false;
  const edited = h.input(1);
  edited.listing = clone(h.listing);
  edited.body = { ...edited.body, title: "new submitted title", price: 700 };
  edited.assets[0] = { ...edited.assets[0], uri: "file:///selected/replacement.jpg", name: "replacement.jpg" };
  await h.coordinator.enqueue(edited);
  await until(() => h.completed.length === 1);
  assert.equal(h.completed[0].title, "new submitted title");
  assert.equal(h.completed[0].price, 700);
  assert.equal(h.uploads.at(-1).asset.name, "replacement.jpg");
  assert.equal(h.requests.filter(call => call.method === "POST").length, 1);
});

test("absence from a page is checked once per snapshot and a confirmed 404 retires the completed overlay", async () => {
  let removed = false;
  const h = harness({ request: call => {
    if (removed && call.method === "GET") throw Object.assign(new Error("not found"), { status: 404 });
  } });
  await h.coordinator.enqueue(h.input(0));
  await until(() => h.completed.length === 1);
  const before = h.requests.length;
  removed = true;
  const page = [];
  h.coordinator.reconcile(page);
  h.coordinator.reconcile(page);
  await until(() => h.coordinator.getSnapshot().length === 0);
  assert.equal(h.requests.length, before + 1);
});

test("handoff waits for journal hydration so a restored submission cannot be duplicated or replaced by edited input", async () => {
  const original = harness({ request: () => { throw new Error("offline"); } });
  const input = original.input(0);
  await original.coordinator.enqueue(input);
  await until(() => original.coordinator.getSnapshot()[0].phase === "failed");
  await until(() => original.journal.get("account-a")?.[0]?.phase === "failed");
  const hydration = gate();
  const h = harness({ load: () => hydration.promise, request: () => { throw new Error("offline"); } });
  h.journal.set("account-a", clone(original.journal.get("account-a")));
  const waiting = h.coordinator.enqueue({ ...input, body: { ...input.body, title: "edited input" } });
  assert.equal(h.requests.length, 0);
  hydration.resolve();
  await assert.rejects(waiting, /محاولة نشر سابقة/);
  assert.equal(h.coordinator.getSnapshot().length, 1);
  assert.equal(h.coordinator.getSnapshot()[0].body.title, input.body.title);
  assert.equal(h.requests.length, 0);
});

test("changing account during hydration cannot hand off the old account's submission", async () => {
  const hydration = gate();
  const h = harness({ load: () => hydration.promise });
  const waiting = h.coordinator.enqueue(h.input(0));
  h.switchAccount("account-b");
  hydration.resolve();
  await assert.rejects(waiting, /publication_account_changed/);
  assert.equal(h.requests.length, 0);
  assert.equal(h.coordinator.getSnapshot().length, 0);
});

test("native publication storage keeps private photo copies and account/origin-scoped journals without credentials", async () => {
  const files = new Map([["file:///selected.jpg", "jpeg-selected-bytes"]]);
  const directories = new Set();
  const uri = parts => parts.map(part => typeof part === "string" ? part : part.uri).join("/");
  class Directory {
    constructor(...parts) { this.uri = uri(parts); }
    create() { directories.add(this.uri); }
    get exists() { return directories.has(this.uri); }
    async delete() { for (const key of files.keys()) if (key.startsWith(`${this.uri}/`)) files.delete(key); directories.delete(this.uri); }
  }
  class File {
    constructor(...parts) { this.uri = uri(parts); }
    get exists() { return files.has(this.uri); }
    get size() { return Buffer.byteLength(files.get(this.uri) ?? ""); }
    async text() { return files.get(this.uri); }
    async write(value) { files.set(this.uri, value); }
    async copy(target) { assert.ok(this.exists); files.set(target.uri, files.get(this.uri)); }
    async move(target) { files.set(target.uri, files.get(this.uri)); files.delete(this.uri); this.uri = target.uri; }
  }
  let origin = "https://api-one.invalid";
  const { publicationStorage } = actualModule("src/core/listing-publication-storage.ts", {
    "expo-file-system": { File, Directory, Paths: { document: "file:///private-documents" } },
    "react-native": { Platform: { OS: "android" } }, "zod": require("zod"),
    "./api": { getApiBaseUrl: () => origin },
  });
  const h = harness();
  const job = { ...h.input(1), createKey: randomUUID(), saveKey: randomUUID(), publishKey: randomUUID(), primaryKey: randomUUID(),
    createdAt: new Date().toISOString(), saved: false, hadImages: false, phase: "saving",
    listing: { id: "local-id", sellerId: "account-a", category: "furniture", status: "draft", images: [], attributes: {} } };
  delete job.assets; delete job.uploadKeys;
  const selected = { uri: "file:///selected.jpg", name: "selected.jpg", type: "image/jpeg" };
  const retained = await publicationStorage.keepPhoto("account-a", job.id, 0, selected);
  assert.notEqual(retained.uri, selected.uri);
  job.photos = [{ asset: retained, key: randomUUID(), resume: {
    key: 'retained-reservation', didPut: false, mayHaveCommitted: true,
    upload: { id: 'retained-upload', status: 'pending', expiresAt: new Date(Date.now() + 3600000).toISOString() },
  } }];
  await publicationStorage.store("account-a", [job]);
  files.delete(selected.uri);
  assert.equal(new File(retained.uri).exists, true);
  const loaded = await publicationStorage.load("account-a");
  assert.equal(loaded[0].photos[0].asset.uri, retained.uri);
  assert.equal(loaded[0].photos[0].resume.mayHaveCommitted, true);
  assert.equal(JSON.stringify(loaded).includes("account-a-token"), false);
  assert.equal((await publicationStorage.load("account-b")).length, 0);
  origin = "https://api-two.invalid";
  assert.equal((await publicationStorage.load("account-a")).length, 0);
  origin = "https://api-one.invalid";
  await publicationStorage.releasePhotos("account-a", job.id);
  assert.equal(new File(retained.uri).exists, false);
});
