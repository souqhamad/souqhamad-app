const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { createHash, randomUUID } = require("node:crypto");
const ts = require("typescript");

const photo = { uri: "file:///sandbox/selected.jpg", type: "image/jpeg", name: "selected.jpg" };
const capability = { protocol: "r2-direct-v1", enabled: true };
const signedUrl = "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/private/job/raw.jpg?X-Amz-Signature=fixture";
const listing = { id: "listing-one", sellerId: "account-a", status: "draft", images: [{ id: "image-ready", status: "approved" }] };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function gate() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function actualModule(relative, imports, globals = {}) {
  const filename = path.resolve(__dirname, "..", relative);
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports,
    require: id => { assert.ok(Object.hasOwn(imports, id), `Unexpected import ${id}`); return imports[id]; },
    URL, Headers, FormData, AbortController, Uint8Array, ArrayBuffer, Date, setTimeout, clearTimeout,
    process: { env: { EXPO_PUBLIC_API_URL: "https://api.invalid" } }, __DEV__: false,
    ...globals,
  }, { filename });
  return module.exports;
}
function harness(options = {}) {
  const requests = [];
  const bytes = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]).buffer;
  let reads = 0, hashes = 0;
  const response = status => ({ upload: { id: "job-one", status, expiresAt: new Date(Date.now() + 3600000).toISOString() },
    ...(status === "ready" ? { listing } : {}) });
  const initiation = () => ({ ...response("pending"), transfer: { url: signedUrl, method: "PUT",
    headers: { "Content-Type": "image/jpeg", "If-None-Match": "*", "Content-Length": String(bytes.byteLength) } } });
  const native = async (url, init = {}) => {
    const call = { url, ...init, headers: new Headers(init.headers) };
    requests.push(call);
    const custom = await options.request?.(call, { response, initiation, requests });
    if (custom !== undefined) return custom;
    if (url.startsWith("https://api.invalid")) {
      if (init.method === "POST" && url.endsWith("/image-uploads")) return Response.json(initiation());
      if (init.method === "POST" && url.endsWith("/images")) return Response.json({ listing });
      if (init.method === "DELETE") return Response.json(response("cancelled"));
      return Response.json(response("ready"));
    }
    assert.equal(url, signedUrl);
    return { ok: true, status: 200, redirected: false, url };
  };
  const File = class {
    constructor(uri) { assert.equal(uri, photo.uri); this.size = bytes.byteLength; }
    async arrayBuffer() { reads++; await options.read?.(); return bytes; }
    async bytes() { return new Uint8Array(bytes); }
  };
  const api = actualModule("src/core/api.ts", {
    "expo/fetch": { fetch: native }, "expo-file-system": { File }, "react-native": { Platform: { OS: options.platform ?? "android" } },
  });
  api.setApiIdentity("token-account-a");
  const client = actualModule("src/core/listing-image-upload.ts", {
    "expo/fetch": { fetch: native }, "expo-file-system": { File }, "react-native": { Platform: { OS: options.platform ?? "android" } },
    "expo-crypto": { randomUUID, CryptoDigestAlgorithm: { SHA256: "SHA-256" }, digest: async (_, input) => {
      hashes++; await options.hash?.();
      const digest = createHash("sha256").update(new Uint8Array(input)).digest();
      return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength);
    } }, "./api": api,
  });
  const uploads = new client.ListingImageUploadClient();
  return { api, uploads, requests, bytes, get reads() { return reads; }, get hashes() { return hashes; },
    run: extra => uploads.uploadListingImage(listing.id, photo, { capability, idempotencyKey: "initial-key", ...extra }) };
}
async function settle(t, pending, condition = () => false, rounds = 15) {
  let complete = false, value, failure;
  pending.then(result => { complete = true; value = result; }, error => { complete = true; failure = error; });
  for (let i = 0; i < rounds && !complete && !condition(); i++) { await flush(); t.mock.timers.tick(2000); }
  await flush();
  if (failure) throw failure;
  return { complete, value };
}
const useClock = t => t.mock.timers.enable({ apis: ["setTimeout", "Date"] });

test("after seven completed photos, a stalled eighth PUT response reconciles the saved image without sending it again", async t => {
  useClock(t);
  const neverResponds = gate();
  const accepted = { ...listing, images: Array.from({ length: 8 }, (_, index) => ({ id: `accepted-${index}`, status: 'approved' })) };
  const h = harness({ request: (call, { response }) => {
    if (call.method === 'PUT') return neverResponds.promise;
    if (call.method === 'GET') return Response.json({ ...response('ready'), listing: accepted });
  } });
  const stages = [], finished = [];
  const { runImageUploadBatch } = actualModule('src/core/image-upload-batch.ts', {});
  const pending = runImageUploadBatch(Array.from({ length: 8 }, (_, index) => index), async (index, _slot, transferred) => {
    if (index < 7) { finished.push(index); transferred(); return; }
    const result = await h.run({ onTransferred: transferred, onStage: stage => stages.push(stage) });
    assert.equal(result.listing.images.length, 8);
    finished.push(index);
  });
  const outcome = pending.then(() => 'complete', failure => failure.code);
  for (let index = 0; index < 8; index++) { await flush(); if (h.requests.some(call => call.method === 'PUT')) break; }
  assert.equal(finished.length, 7);
  assert.equal(stages.at(-1), 'uploading');
  t.mock.timers.tick(120000); await flush();
  assert.equal(await outcome, 'complete');
  assert.equal(finished.length, 8);
  assert.equal(h.requests.filter(call => call.method === 'PUT').length, 1);
  assert.equal(stages.at(-1), 'ready');
});

test("a settled upload failure replaces the uploading stage and keeps the reservation retryable", async t => {
  useClock(t);
  const stages = [];
  const h = harness({ request: (call, { response }) => {
    if (call.method === 'PUT') throw new Error('transport failed');
    if (call.method === 'GET') return Response.json(response('pending'));
  } });
  await assert.rejects(h.run({ onStage: stage => stages.push(stage) }), failure => failure.code === 'network');
  assert.equal(stages.at(-1), 'failed');
  assert.deepEqual([...h.uploads.getActiveUploadIds()], []);
  assert.equal(h.uploads.getResumeState(photo.uri).upload.id, 'job-one');
});

test("an accepted PUT with a lost response reconciles R2 without uploading bytes again", async t => {
  useClock(t);
  const h = harness({ request: (call, { response }) => {
    if (call.method === 'PUT') throw new Error('response lost after R2 commit');
    if (call.url.endsWith('?reconcile=1')) return Response.json({ ...response('pending'), sourceUploaded: true });
  } });
  const done = await settle(t, h.run());
  assert.equal(done.complete, true);
  assert.equal(done.value.listing.id, listing.id);
  assert.equal(h.requests.filter(call => call.method === 'PUT').length, 1);
  assert.equal(h.uploads.getResumeState(photo.uri).mayHaveCommitted, false);
});

for (const platform of ['android', 'ios']) test(`${platform}: reservation throttling waits Retry-After and resumes the same image`, async t => {
  useClock(t);
  let reservations = 0;
  const h = harness({ platform, request: call => {
    if (call.method === 'POST' && ++reservations === 1)
      return Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '5' } });
  } });
  let complete = false;
  const pending = h.run();
  pending.then(() => { complete = true; }, () => {});
  await flush();
  assert.equal(reservations, 1);
  t.mock.timers.tick(4999); await flush();
  assert.equal(reservations, 1, 'do not retry before the server permits it');
  t.mock.timers.tick(1); await flush();
  const result = await settle(t, pending);
  assert.equal(result.complete, true);
  assert.equal(complete, true);
  const posts = h.requests.filter(call => call.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].headers.get('idempotency-key'), posts[1].headers.get('idempotency-key'));
  assert.equal(posts[0].body, posts[1].body);
  assert.equal(h.requests.filter(call => call.method === 'PUT').length, 1);
});

test('rate-limit waits remain bounded and account changes cancel them before a new request', async t => {
  useClock(t);
  for (const retryAfter of ['300', undefined]) {
    const h = harness({ request: call => {
      if (call.method === 'POST') return Response.json({ error: 'rate_limited' },
        { status: 429, headers: retryAfter ? { 'Retry-After': retryAfter } : {} });
    } });
    await assert.rejects(h.run(), failure => failure.status === 429);
    assert.equal(h.requests.length, 1);
  }
  const h = harness({ request: call => {
    if (call.method === 'POST') return Response.json({ error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': '5' } });
  } });
  const pending = h.run();
  const rejected = assert.rejects(pending, failure => failure.code === 'account_changed');
  await flush();
  h.api.setApiIdentity('account-b');
  await rejected;
  t.mock.timers.tick(5000); await flush();
  assert.equal(h.requests.length, 1);
});

test('persistent reservation throttling stops without sending image bytes', async t => {
  useClock(t);
  const h = harness({ request: call => {
    if (call.method === 'POST') return Response.json({ error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': '1' } });
  } });
  await assert.rejects(settle(t, h.run()), failure => failure.status === 429);
  assert.equal(h.requests.filter(call => call.method === 'POST').length, 3);
  assert.equal(h.requests.some(call => call.method === 'PUT'), false);
});

test('a status read respects an HTTP-date Retry-After without retransferring the image', async t => {
  useClock(t);
  let polls = 0;
  const h = harness({ request: call => {
    if (call.method === 'GET' && ++polls === 1) return Response.json({ error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': new Date(Date.now() + 5000).toUTCString() } });
  } });
  const done = await settle(t, h.run());
  assert.equal(done.complete, true);
  assert.equal(polls, 2);
  assert.equal(h.requests.filter(call => call.method === 'PUT').length, 1);
  assert.equal(h.requests.filter(call => call.method === 'POST').length, 1);
});

test("a missing R2 source retries only the failed transfer once", async t => {
  useClock(t);
  let puts = 0;
  const h = harness({ request: (call, { response }) => {
    if (call.method === 'PUT' && ++puts === 1) throw new Error('network interrupted before commit');
    if (call.url.endsWith('?reconcile=1')) return Response.json({ ...response('pending'), sourceUploaded: false });
  } });
  const done = await settle(t, h.run());
  assert.equal(done.complete, true);
  assert.equal(puts, 2);
  assert.equal(h.requests.filter(call => call.method === 'POST').length, 1);
});

test("a persisted ambiguous PUT reconciles before reading local bytes or renewing the transfer", async t => {
  useClock(t);
  const h = harness({ request: (call, { response }) => {
    if (call.url.endsWith('?reconcile=1')) return Response.json({ ...response('pending'), sourceUploaded: true });
  } });
  h.uploads.restoreListingImage(listing.id, photo, { key: 'restored-key', didPut: false, mayHaveCommitted: true,
    upload: { id: 'job-one', status: 'pending', expiresAt: new Date(Date.now() + 3600000).toISOString() } });
  const done = await settle(t, h.run());
  assert.equal(done.complete, true);
  assert.equal(h.reads, 0);
  assert.equal(h.requests.some(call => ['POST', 'PUT'].includes(call.method)), false);
});

for (const platform of ["android", "ios"]) for (const failure of ["network", "503"]) {
  test(`${platform}: a transient ${failure} status read recovers without repeating the reservation or transfer`, async t => {
    useClock(t);
    let polls = 0;
    const h = harness({ platform, request: call => {
      if (call.method === "GET" && ++polls === 1) {
        if (failure === "network") throw new Error("temporary_connection_failure");
        return Response.json({ error: "image_processing_unavailable" }, { status: 503 });
      }
    } });
    const done = await settle(t, h.run());
    assert.equal(done.complete, true);
    assert.equal(done.value.listing.images[0].id, "image-ready");
    assert.equal(polls, 2);
    assert.equal(h.requests.filter(call => call.method === "PUT").length, 1);
    assert.equal(h.requests.filter(call => call.method === "POST").length, 1);
    h.uploads.cancelAll();
  });
}

test("persistent image status failures stop after bounded read retries and retain the uploaded bytes for recovery", async t => {
  useClock(t);
  let polls = 0;
  const h = harness({ request: call => {
    if (call.method === "GET") { polls++; throw new Error("still_disconnected"); }
  } });
  await assert.rejects(settle(t, h.run()), error => error.code === "network");
  assert.equal(polls, 3);
  assert.equal(h.requests.filter(call => call.method === "PUT").length, 1);
  h.uploads.cancelAll();
});

test("authentication rejection during image status is never retried", async t => {
  useClock(t);
  let polls = 0;
  const h = harness({ request: call => {
    if (call.method === "GET") { polls++; return Response.json({ error: "auth_required" }, { status: 401 }); }
  } });
  await assert.rejects(settle(t, h.run()), error => error.status === 401);
  assert.equal(polls, 1);
  h.uploads.cancelAll();
});

for (const platform of ["android", "ios"]) test(`${platform}: direct upload preserves JPEG bytes through Expo transport and waits pending→processing→ready`, async t => {
  useClock(t);
  let polls = 0;
  const h = harness({ platform, request: (call, { response }) => {
    if (call.url.includes("image-uploads/job-one") && call.method === "GET")
      return Response.json(response(++polls === 1 ? "pending" : polls === 2 ? "processing" : "ready"));
  } });
  const pending = h.run();
  await flush();
  const put = h.requests.find(call => call.method === "PUT");
  assert.ok(put);
  assert.equal(put.headers.get("authorization"), null);
  assert.equal(put.headers.get("cookie"), null);
  assert.equal(put.credentials, "omit");
  assert.equal(put.redirect, "error");
  assert.equal(put.headers.get("if-none-match"), "*");
  assert.deepEqual([...new Uint8Array(put.body)], [...new Uint8Array(h.bytes)]);
  // Exercise the installed SDK's native request normalizer, in addition to the
  // application client. SigV4 headers must survive without a multipart wrapper.
  const expoTransport = actualModule("node_modules/expo/src/winter/fetch/RequestUtils.ts", {
    "../../utils/blobUtils": { blobToArrayBufferAsync: blob => blob.arrayBuffer() },
    "./convertFormData": { convertFormDataAsync: () => { throw new Error("Direct R2 transfer must not become multipart"); } },
  });
  const nativeBody = await expoTransport.normalizeBodyInitAsync(put.body);
  const nativeHeaders = new Headers(expoTransport.overrideHeaders(expoTransport.normalizeHeadersInit(put.headers), nativeBody.overriddenHeaders ?? []));
  assert.deepEqual([...nativeBody.body], [...new Uint8Array(h.bytes)]);
  assert.equal(nativeHeaders.get("content-type"), "image/jpeg");
  assert.equal(nativeHeaders.get("if-none-match"), "*");
  assert.equal(nativeHeaders.get("content-length"), String(h.bytes.byteLength));
  assert.equal(nativeHeaders.get("authorization"), null);
  const init = h.requests.find(call => call.method === "POST");
  const metadata = JSON.parse(init.body);
  assert.equal(metadata.sizeBytes, h.bytes.byteLength);
  assert.equal(metadata.sha256, createHash("sha256").update(new Uint8Array(h.bytes)).digest("hex"));
  assert.equal(init.headers.get("authorization"), "Bearer token-account-a");
  assert.equal(init.headers.get("idempotency-key"), "initial-key");
  const done = await settle(t, pending);
  assert.equal(done.complete, true);
  assert.equal(done.value.listing.images[0].id, "image-ready");
  assert.equal(polls, 3);
  h.uploads.cancelAll();
});

for (const stage of ["read", "hash"]) test(`account switch during ${stage} cannot initiate a job for the new account`, async () => {
  const pause = gate();
  const h = harness({ [stage]: () => pause.promise });
  const pending = h.run();
  const rejected = assert.rejects(pending, error => error.code === "account_changed");
  await flush(); h.api.setApiIdentity("token-account-b"); pause.resolve();
  await rejected;
  assert.equal(h.requests.length, 0);
  h.uploads.cancelAll();
});

test("account switch aborts R2 and never cancels the old job with the new bearer", async () => {
  const started = gate();
  const h = harness({ request: call => {
    if (call.method === "PUT") {
      started.resolve(call);
      return new Promise((_, reject) => call.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }
  } });
  const pending = h.run();
  const rejected = assert.rejects(pending, error => error.code === "account_changed");
  const put = await started.promise;
  h.api.setApiIdentity("token-account-b");
  await rejected;
  assert.equal(put.signal.aborted, true);
  h.uploads.cancelAll();
  assert.equal(h.requests.filter(call => call.method === "DELETE").length, 0);
});

test("a screen-scoped client cannot resume or initiate its old asset for another account, even the same token returning", async () => {
  for (const restore of [false, true]) {
    const h = harness();
    h.api.setApiIdentity("token-account-b");
    if (restore) h.api.setApiIdentity("token-account-a");
    await assert.rejects(h.run(), error => error.code === "account_changed");
    assert.equal(h.requests.length, 0);
    h.uploads.cancelAll();
  }
});

test("timeout retains the job and resumes polling without reupload even after capability becomes disabled", async t => {
  useClock(t);
  let finish = false;
  const h = harness({ request: (call, { response }) => {
    if (call.method === "GET") return Response.json(response(finish ? "ready" : "processing"));
  } });
  const first = h.run();
  const rejected = assert.rejects(first, error => error.code === "image_processing_timeout");
  await flush();
  assert.deepEqual([...h.uploads.getActiveUploadIds()], ["job-one"]);
  t.mock.timers.tick(180000); await rejected;
  assert.deepEqual([...h.uploads.getActiveUploadIds()], [], "a settled attempt must release polling ownership for recovery");
  finish = true;
  const result = await h.run({ capability: { protocol: "r2-direct-v1", enabled: false } });
  assert.equal(result.listing.id, listing.id);
  assert.equal(h.requests.filter(call => call.method === "PUT").length, 1);
  assert.equal(h.requests.filter(call => call.method === "POST").length, 1);
  assert.equal(h.reads, 1);
  h.uploads.cancelAll();
});

test("failed processing rejects without legacy fallback; explicit retry uses a new job key", async t => {
  useClock(t);
  let fail = true;
  const h = harness({ request: (call, { response }) => {
    if (call.method === "GET") return Response.json(response(fail ? "failed" : "ready"));
  } });
  const first = h.run();
  await assert.rejects(settle(t, first), error => error.code === "image_processing_failed");
  assert.equal(h.requests.some(call => call.url.endsWith("/images")), false);
  fail = false;
  const retry = await settle(t, h.run());
  assert.equal(retry.complete, true);
  const keys = h.requests.filter(call => call.method === "POST").map(call => call.headers.get("idempotency-key"));
  assert.notEqual(keys[0], keys[1]);
  h.uploads.cancelAll();
});

test("publication checkpoints retain a safe reservation before PUT and can resume in a new client during rollback", async t => {
  useClock(t);
  const reserved = gate(); let phase = "processing", checkpoint;
  const h = harness({ request: (call, { response }) => {
    if (call.method === "GET") return Response.json(response(phase));
  } });
  const first = h.run({ onCheckpoint: async state => { checkpoint = state; await reserved.promise; } });
  const rejected = assert.rejects(first, error => error.code === "image_processing_timeout");
  await flush();
  assert.equal(checkpoint.upload.id, "job-one");
  assert.equal(checkpoint.didPut, false);
  assert.equal(h.requests.some(call => call.method === "PUT"), false);
  assert.equal(JSON.stringify(checkpoint).includes("Signature"), false);
  assert.equal(JSON.stringify(checkpoint).includes("token-account-a"), false);
  reserved.resolve(); await flush();
  t.mock.timers.tick(180000); await rejected;
  const persisted = h.uploads.getResumeState(photo.uri);
  assert.equal(persisted.didPut, true);
  const restored = new h.uploads.constructor();
  restored.restoreListingImage(listing.id, photo, persisted);
  phase = "cancelled";
  const before = h.requests.length;
  const result = await restored.uploadListingImage(listing.id, photo, {
    capability: { protocol: "r2-direct-v1", enabled: false }, idempotencyKey: persisted.key,
  });
  assert.equal(result.listing.id, listing.id);
  assert.deepEqual(h.requests.slice(before).map(call => [call.method, call.url.endsWith("/images")]), [["GET", false], ["POST", true]]);
  assert.equal(h.requests.filter(call => call.method === "PUT").length, 1);
});

test("expired job reinitializes and a conditional PUT 412 proceeds to verified server status", async t => {
  useClock(t);
  let failPut = true, expired = false;
  const h = harness({ request: (call, { response }) => {
    if (call.method === "PUT") {
      if (failPut) throw new Error("transport interrupted");
      return { ok: false, status: 412, redirected: false, url: call.url };
    }
    if (call.method === "GET" && !expired) { expired = true; return Response.json(response("expired")); }
  } });
  await assert.rejects(h.run(), error => error.code === "network");
  failPut = false;
  const done = await settle(t, h.run());
  assert.equal(done.complete, true);
  assert.equal(h.requests.filter(call => call.method === "POST").length, 2);
  h.uploads.cancelAll();
});

test("a lost initiation response reuses its idempotency key and exact metadata instead of creating a second job", async t => {
  useClock(t);
  let initiations = 0;
  const h = harness({ request: call => {
    if (call.method === "POST" && ++initiations === 1) throw new Error("response lost after reservation");
  } });
  await assert.rejects(h.run(), failure => failure.code === "network");
  const done = await settle(t, h.run());
  assert.equal(done.complete, true);
  const posts = h.requests.filter(call => call.method === "POST");
  assert.equal(posts.length, 2);
  assert.equal(posts[0].headers.get("idempotency-key"), posts[1].headers.get("idempotency-key"));
  assert.deepEqual(JSON.parse(posts[0].body), JSON.parse(posts[1].body));
  assert.equal(h.requests.filter(call => call.method === "PUT").length, 1);
  h.uploads.cancelAll();
});

test("a job completing during transfer renewal loads the current owned listing without uploading twice", async t => {
  useClock(t);
  let puts = 0, initiations = 0, polls = 0;
  const h = harness({ request: (call, { response }) => {
    if (call.url.endsWith('?reconcile=1')) return Response.json(response('pending'));
    if (call.method === "POST" && ++initiations === 2) {
      const complete = response("ready");
      delete complete.listing;
      return Response.json(complete);
    }
    if (call.method === "PUT" && ++puts === 1) throw new Error("upload response lost");
    if (call.method === "GET") { polls++; return Response.json(response("ready")); }
  } });
  await assert.rejects(h.run(), failure => failure.code === "network");
  const done = await settle(t, h.run());
  assert.equal(done.complete, true);
  assert.equal(done.value.listing.id, listing.id);
  assert.equal(puts, 1);
  assert.equal(polls, 1);
  const posts = h.requests.filter(call => call.method === "POST");
  assert.equal(posts[0].headers.get("idempotency-key"), posts[1].headers.get("idempotency-key"));
  h.uploads.cancelAll();
});

test("polling cannot silently switch from one upload job to another", async t => {
  useClock(t);
  const h = harness({ request: (call, { response }) => {
    if (call.method === "GET") {
      const unrelated = response("ready");
      unrelated.upload.id = "another-job";
      return Response.json(unrelated);
    }
  } });
  await assert.rejects(settle(t, h.run()), failure => failure.code === "invalid_response");
  assert.equal(h.requests.some(call => call.url.endsWith("/images")), false);
  h.uploads.cancelAll();
});

test("an account switch during processing stops polling and never deletes using the new account", async t => {
  useClock(t);
  const processing = gate();
  const h = harness({ request: (call, { response }) => {
    if (call.method === "GET") return Response.json(response("processing"));
  } });
  const pending = h.run({ onStage: stage => { if (stage === 'processing') processing.resolve(); } });
  const rejected = assert.rejects(pending, failure => failure.code === "account_changed");
  await processing.promise;
  t.mock.timers.tick(1000); await flush();
  assert.ok(h.requests.some(call => call.method === "GET"));
  h.api.setApiIdentity("token-account-b");
  await rejected;
  h.uploads.cancelAll();
  const numberOfRequests = h.requests.length;
  t.mock.timers.tick(20000); await flush();
  assert.equal(h.requests.length, numberOfRequests);
  assert.equal(h.requests.some(call => call.method === "DELETE"), false);
});

test("closing the screen cancels the current job with its initiating account", async () => {
  const began = gate();
  const h = harness({ request: call => {
    if (call.method === "PUT") {
      began.resolve();
      return new Promise((_, reject) => call.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }
  } });
  const pending = h.run();
  const rejected = assert.rejects(pending, error => error.code === "aborted");
  await began.promise; h.uploads.cancelAll();
  await rejected; await flush();
  const cancel = h.requests.find(call => call.method === "DELETE");
  assert.ok(cancel);
  assert.equal(cancel.headers.get("authorization"), "Bearer token-account-a");
});

test("absent or disabled capability keeps legacy multipart and never initializes direct protocol", async () => {
  for (const mode of [undefined, { protocol: "r2-direct-v1", enabled: false }]) {
    const h = harness();
    const result = await h.run({ capability: mode });
    assert.equal(result.listing.id, listing.id);
    assert.equal(h.requests.length, 1);
    assert.ok(h.requests[0].body instanceof FormData);
    assert.equal(h.requests[0].url.endsWith("/images"), true);
    assert.equal(h.hashes, 0);
  }
});

for (const problem of ["http", "redirect", "bearer", "length", "malformed-length"]) test(`unsafe ${problem} transfer is rejected without falling back to multipart`, async () => {
  const h = harness({ request: (call, { initiation }) => {
    if (call.method === "POST") {
      const init = initiation();
      if (problem === "http") init.transfer.url = signedUrl.replace("https:", "http:");
      if (problem === "bearer") init.transfer.headers.Authorization = "Bearer should-not-leave-api";
      if (problem === "length") init.transfer.headers["Content-Length"] = "100";
      if (problem === "malformed-length") init.transfer.headers["Content-Length"] = "7e0";
      return Response.json(init);
    }
    if (call.method === "PUT" && problem === "redirect") return { ok: true, status: 200, redirected: true, url: "https://other.invalid" };
  } });
  await assert.rejects(h.run(), error => ["invalid_image_transfer", "image_transfer_failed"].includes(error.code));
  assert.equal(h.requests.some(call => call.url.endsWith("/images")), false);
  h.uploads.cancelAll(); await flush();
});

test("disabled direct capability switches an existing asset to multipart only after confirmed cancellation", async () => {
  let status = "pending";
  const h = harness({ request: (call, { response }) => {
    if (call.method === "PUT") throw new Error("ambiguous transfer");
    if (call.method === "GET") return Response.json(response(status));
  } });
  await assert.rejects(h.run(), failure => failure.code === "network");
  status = "cancelled";
  const result = await h.run({ capability: { ...capability, enabled: false } });
  assert.equal(result.listing.id, listing.id);
  assert.equal(h.requests.filter(call => call.url.endsWith("/images")).length, 1);
  h.uploads.cancelAll();
});

test("disabled capability cannot turn an uncertain direct job into a second multipart upload", async () => {
  const h = harness({ request: call => {
    if (call.method === "PUT" || call.method === "GET") throw new Error("offline");
  } });
  await assert.rejects(h.run(), failure => failure.code === "network");
  await assert.rejects(h.run({ capability: { ...capability, enabled: false } }), failure => failure.code === "network");
  assert.equal(h.requests.some(call => call.url.endsWith("/images")), false);
  h.uploads.cancelAll();
});

function recoveredHarness(options = {}) {
  const states = [], images = [];
  const h = harness(options);
  const { ListingImageUploadRecovery } = actualModule("src/core/listing-image-upload-recovery.ts", { "./api": h.api });
  const recovery = new ListingImageUploadRecovery({ listingId: listing.id, capability: options.capability ?? capability,
    localUploadIds: options.localUploadIds,
    imageRevision: options.imageRevision,
    onState: state => states.push(state), onImages: fresh => images.push(fresh),
  });
  return { ...h, recovery, states, images, state: () => states.at(-1) };
}
const recoverable = (id = "restored-job", status = "processing") => ({ id, status, expiresAt: new Date(Date.now() + 3600000).toISOString() });

test("reopening an editor restores processing rows and refreshes images when the tracked work finishes", async t => {
  useClock(t);
  let polls = 0;
  const h = recoveredHarness({ request: call => {
    if (call.method === "GET" && call.url.endsWith("/image-uploads"))
      return Response.json({ uploads: ++polls < 3 ? [recoverable("restored-job", polls === 1 ? "pending" : "processing")] : [] });
    if (call.method === "GET") return Response.json({ listing: { ...listing, images: polls < 3 ? [] : listing.images } });
  } });
  h.recovery.start(); await flush();
  assert.equal(h.state().uploads[0].id, "restored-job");
  assert.equal(h.images[0].images.length, 0);
  t.mock.timers.tick(2000); await flush();
  assert.equal(h.state().uploads[0].status, "processing");
  t.mock.timers.tick(2000); await flush();
  assert.equal(h.state().uploads.length, 0);
  assert.equal(h.images.at(-1).images[0].id, "image-ready");
  assert.equal(h.requests.filter(call => call.method === "PUT" || call.method === "POST").length, 0);
  h.recovery.stop();
});

test("a restored row stays present after an offline cancellation and disappears only after server confirmation", async t => {
  useClock(t);
  let failedCancel = true, active = true;
  const h = recoveredHarness({ request: call => {
    if (call.method === "DELETE") {
      if (failedCancel) throw new Error("offline");
      active = false; return Response.json({ upload: { ...recoverable(), status: "cancelled" } });
    }
    if (call.url.endsWith("/image-uploads")) return Response.json({ uploads: active ? [recoverable()] : [] });
    if (call.method === "GET") return Response.json({ listing });
  } });
  h.recovery.start(); await flush();
  await h.recovery.cancel("restored-job");
  assert.equal(h.state().uploads.length, 1);
  assert.ok(h.state().error);
  failedCancel = false;
  await h.recovery.cancel("restored-job"); await flush();
  assert.equal(h.state().uploads.length, 0);
  assert.equal(h.state().error, null);
  const deletes = h.requests.filter(call => call.method === "DELETE");
  assert.equal(deletes.length, 2);
  assert.ok(deletes.every(call => call.headers.get("authorization") === "Bearer token-account-a"));
  h.recovery.stop();
});

test("recovery ignores new uploads owned by the current editor and tracks only the opening snapshot", async t => {
  useClock(t);
  let poll = 0;
  const h = recoveredHarness({ localUploadIds: () => new Set(["current-job"]), request: call => {
    if (call.url.endsWith("/image-uploads")) {
      poll++;
      return Response.json({ uploads: poll === 1 ? [recoverable(), recoverable("current-job")] : [recoverable("later-job")] });
    }
    if (call.method === "GET") return Response.json({ listing });
  } });
  h.recovery.start(); await flush();
  assert.deepEqual([...h.state().uploads].map(upload => upload.id), ["restored-job"]);
  t.mock.timers.tick(2000); await flush();
  assert.equal(h.state().uploads.length, 0);
  h.recovery.stop();
});

test("a previous server without the upload capability receives no recovery requests", () => {
  const h = recoveredHarness({ capability: { protocol: "old-server", enabled: false } });
  h.recovery.start();
  assert.equal(h.requests.length, 0);
  h.recovery.stop();
});

test("rollback with a known protocol still discovers and clears old reservations", async () => {
  const h = recoveredHarness({ capability: { ...capability, enabled: false }, request: call => {
    if (call.url.endsWith("/image-uploads")) return Response.json({ uploads: [] });
    if (call.method === "GET") return Response.json({ listing });
  } });
  h.recovery.start(); await flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.state().uploads.length, 0);
  assert.equal(h.images[0].id, listing.id);
  h.recovery.stop();
});

test("explicit recovery retry discovers an initiation that committed after the opening snapshot", async () => {
  let active = false;
  const h = recoveredHarness({ request: call => {
    if (call.url.endsWith("/image-uploads")) return Response.json({ uploads: active ? [recoverable()] : [] });
    if (call.method === "GET") return Response.json({ listing });
  } });
  h.recovery.start(); await flush();
  assert.equal(h.state().uploads.length, 0);
  active = true;
  h.recovery.retry(); await flush();
  assert.equal(h.state().uploads[0].id, "restored-job");
  h.recovery.stop();
});

test("a late restored response or cancellation cannot affect a replacement account", async () => {
  const pause = gate();
  const h = recoveredHarness({ request: async call => {
    if (call.url.endsWith("/image-uploads")) { await pause.promise; return Response.json({ uploads: [recoverable()] }); }
  } });
  h.recovery.start(); await flush();
  h.api.setApiIdentity("token-account-b");
  const before = h.states.length;
  pause.resolve(); await flush();
  await h.recovery.cancel("restored-job");
  assert.equal(h.states.length, before);
  assert.equal(h.images.length, 0);
  assert.equal(h.requests.some(call => call.method === "DELETE"), false);
  h.recovery.stop();
});

test("restored readiness merges only image records and preserves local listing fields", () => {
  const h = harness();
  const { mergeRecoveredListingImages } = actualModule("src/core/listing-image-upload-recovery.ts", { "./api": h.api });
  const current = { ...listing, title: "عنوان محلي", description: "وصف محلي", attributes: { year: 2025 }, images: [] };
  const fresh = { ...listing, title: "عنوان قديم في السيرفر", description: "وصف قديم", attributes: { year: 2020 } };
  const merged = mergeRecoveredListingImages(current, fresh);
  assert.equal(merged.title, current.title);
  assert.equal(merged.description, current.description);
  assert.equal(merged.attributes, current.attributes);
  assert.equal(merged.images, fresh.images);
  assert.equal(mergeRecoveredListingImages(null, fresh), null);
  assert.equal(mergeRecoveredListingImages(current, { ...fresh, id: "another-listing" }), current);
});

test("a delayed recovery snapshot cannot restore a photo deleted by a newer editor action", async t => {
  useClock(t);
  const pause = gate();
  let revision = 0, reads = 0;
  const h = recoveredHarness({ imageRevision: () => revision, request: async call => {
    if (call.url.endsWith("/image-uploads")) return Response.json({ uploads: [] });
    if (++reads === 1) {
      await pause.promise;
      return Response.json({ listing });
    }
    return Response.json({ listing: { ...listing, images: [] } });
  } });
  h.recovery.start(); await flush();
  revision++; // The delete response has committed a newer image list.
  pause.resolve(); await flush();
  assert.equal(h.images.length, 0, "the old photo list must not reach the editor or cache");
  t.mock.timers.tick(0); await flush();
  assert.equal(h.images.length, 1);
  assert.equal(h.images[0].images.length, 0);
  assert.equal(h.state().error, null);
  h.recovery.stop();
});


test("parallel preparation keeps reservations in selection order while R2 transfers overlap", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const firstHash = gate(), putA = gate(), putB = gate();
  const reservations = [], puts = [], stages = { a: [], b: [] };
  const bytes = new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9]).buffer;
  const identity = { token: "owner", generation: 1 };
  class ApiError extends Error {}
  const api = {
    post: async (_path, metadata) => {
      const id = metadata.fileName; reservations.push(id);
      return { upload: { id, status: "pending", expiresAt: new Date(Date.now() + 100000).toISOString() },
        transfer: { url: `${signedUrl}&asset=${id}`, method: "PUT", headers: { "Content-Type": "image/jpeg", "If-None-Match": "*", "Content-Length": String(bytes.byteLength) } } };
    },
    get: async path => ({ upload: { id: path.endsWith("/a") ? "a" : "b", status: "ready", expiresAt: new Date(Date.now() + 100000).toISOString() }, listing }),
  };
  let hashes = 0;
  const module = actualModule("src/core/listing-image-upload.ts", {
    "./api": { api, ApiError, getApiIdentity: () => identity, assertApiIdentity() {}, registerIdentityAbortController: () => () => {} },
    "expo/fetch": { fetch: async url => { const id = new URL(url).searchParams.get("asset"); puts.push(id); await (id === "a" ? putA : putB).promise; return { ok: true, status: 200, url }; } },
    "expo-file-system": { File: class { size = bytes.byteLength; async arrayBuffer() { return bytes; } } },
    "react-native": { Platform: { OS: "android" } },
    "expo-crypto": { randomUUID, CryptoDigestAlgorithm: { SHA256: "SHA-256" }, digest: async () => {
      if (++hashes === 1) await firstHash.promise;
      return new Uint8Array(32).buffer;
    } },
  });
  const client = new module.ListingImageUploadClient();
  const options = id => ({ capability, idempotencyKey: id, onStage: stage => stages[id].push(stage) });
  const a = client.uploadListingImage(listing.id, { ...photo, uri: "file:///a.jpg", name: "a" }, options("a"));
  const b = client.uploadListingImage(listing.id, { ...photo, uri: "file:///b.jpg", name: "b" }, options("b"));
  await flush(); assert.deepEqual(reservations, []);
  firstHash.resolve(); await flush();
  assert.deepEqual(reservations, ["a", "b"]); assert.deepEqual(puts, ["a", "b"]);
  putB.resolve(); await flush(); await t.mock.timers.tick(1000); await flush(); await b;
  assert.equal(stages.a.includes("ready"), false);
  putA.resolve(); await flush(); await t.mock.timers.tick(1000); await flush(); await a;
  assert.deepEqual(stages.a, ["preparing", "uploading", "processing", "ready"]);
  assert.equal(client.getUploadId("file:///a.jpg"), "a");
});


test("confirmed direct transfer releases its observer once before processing finishes", async t => {
  useClock(t);
  const processing = gate();
  let finish = false, transferred = 0, complete = false;
  const stages = [];
  const h = harness({ request: (call, { response }) => {
    if (call.method === "GET") return Response.json(response(finish ? "ready" : "processing"));
  } });
  const pending = h.run({ onTransferred: () => { transferred++; }, onStage: stage => {
    stages.push(stage); if (stage === 'processing') processing.resolve();
  } });
  pending.then(() => { complete = true; });
  await processing.promise;
  assert.equal(transferred, 1);
  assert.equal(complete, false, "publication must still wait for server acceptance");
  assert.equal(stages.at(-1), "processing");
  assert.deepEqual([...h.uploads.getActiveUploadIds()], ["job-one"]);
  t.mock.timers.tick(1000); await flush();
  assert.equal(transferred, 1, "polling must not release the transfer slot repeatedly");
  finish = true;
  assert.equal((await settle(t, pending)).complete, true);
  assert.equal(transferred, 1);
  assert.deepEqual([...h.uploads.getActiveUploadIds()], []);
  h.uploads.cancelAll();
});

test("an ambiguous PUT announces transfer only after server processing confirms it", async t => {
  useClock(t);
  let finish = false, transferred = 0;
  const h = harness({ request: (call, { response }) => {
    if (call.method === "PUT") throw new Error("upload response lost");
    if (call.method === "GET") return Response.json(response(finish ? "ready" : "processing"));
  } });
  const resumed = h.run({ onTransferred: () => { transferred++; } });
  await settle(t, resumed, () => transferred > 0);
  assert.equal(transferred, 1);
  assert.equal(h.requests.filter(call => call.method === "PUT").length, 1);
  finish = true;
  assert.equal((await settle(t, resumed)).complete, true);
  assert.equal(transferred, 1);
  h.uploads.cancelAll();
});

test("transfer observers cannot fail the accepted upload or leak into legacy multipart", async t => {
  useClock(t);
  const direct = harness();
  const pending = direct.run({ onTransferred: () => { throw new Error("UI observer failed"); } });
  assert.equal((await settle(t, pending)).value.listing.id, listing.id);
  direct.uploads.cancelAll();
  let transferred = 0;
  const legacy = harness();
  await legacy.run({ capability: undefined, onTransferred: () => { transferred++; } });
  assert.equal(transferred, 0);
  legacy.uploads.cancelAll();
});


test("recovery retries a transient read failure without reopening and refreshes completed images", async t => {
  useClock(t);
  let reads = 0;
  const h = recoveredHarness({ request: call => {
    if (call.url.endsWith("/image-uploads")) {
      if (++reads === 1) throw new Error("offline");
      return Response.json({ uploads: [] });
    }
    if (call.method === "GET") return Response.json({ listing });
  } });
  h.recovery.start(); await flush();
  assert.ok(h.state().error);
  t.mock.timers.tick(2000); await flush();
  assert.equal(h.state().error, null);
  assert.equal(h.images.at(-1).id, listing.id);
  h.recovery.stop();
});

test("automatic recovery retries are bounded and stop when the editor closes", async t => {
  useClock(t);
  let reads = 0;
  const h = recoveredHarness({ request: call => {
    if (call.method === "GET") { reads++; throw new Error("offline"); }
  } });
  h.recovery.start(); await flush();
  for (const interval of [2000, 4000, 8000, 16000, 30000]) { t.mock.timers.tick(interval); await flush(); }
  assert.equal(reads, 6);
  t.mock.timers.tick(60000); await flush();
  assert.equal(reads, 6);
  h.recovery.retry(); await flush();
  assert.equal(reads, 7);
  h.recovery.stop();
  t.mock.timers.tick(60000); await flush();
  assert.equal(reads, 7);
});
