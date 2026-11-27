import test from "node:test";
import assert from "node:assert/strict";
import { createGalleryPreviewLoader } from "../src/ui/gallery-preview-loader.ts";
import { GalleryPreviewCache } from "../src/ui/gallery-preview-cache.ts";

const URL = "https://images.souqhamad.com/listings/2026/10/photo%20name-display.webp?v=2";
const bytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 87, 69, 66, 80]);
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function resource(width = 900, height = 600) {
  return { width, height, releases: 0, release() { this.releases++; } };
}
function fixture(options = {}) {
  const calls = { cache: [], fetch: [], files: [], decode: [], persist: [] };
  const image = resource();
  const load = createGalleryPreviewLoader({
    cachedPath: async url => {
      calls.cache.push(url);
      return options.cachedPath ? options.cachedPath(url) : null;
    },
    fetch: async (url, settings) => {
      calls.fetch.push({ url, ...settings });
      return options.respond ? options.respond(url, settings) : new Response(bytes);
    },
    temporaryFile: () => {
      const file = { uri: `file:///cache/preview-${calls.files.length}.image`, bytes: undefined, deletions: 0,
        write(value) {
          this.bytes = value;
          return options.write?.(value);
        },
        delete() { this.deletions++; },
      };
      calls.files.push(file);
      return file;
    },
    decode: async uri => {
      calls.decode.push(uri);
      return options.decode ? options.decode(uri) : image;
    },
    persist: async (uri, key) => {
      calls.persist.push({ uri, key });
      return options.persist?.(uri, key);
    },
  });
  return { calls, image, load };
}

test("uncached CDN bytes use cancellable credential-free transfer and preserve the exact cache key", async () => {
  const f = fixture();
  const controller = new AbortController();
  const loaded = await f.load(URL, controller.signal);
  await flush();
  assert.equal(loaded, f.image);
  assert.deepEqual(f.calls.cache, [URL]);
  assert.equal(f.calls.fetch.length, 1);
  assert.equal(f.calls.fetch[0].url, URL);
  assert.equal(f.calls.fetch[0].signal, controller.signal);
  assert.equal(f.calls.fetch[0].credentials, "omit");
  assert.deepEqual(Object.keys(f.calls.fetch[0]).sort(), ["credentials", "signal", "url"]);
  assert.deepEqual(f.calls.files[0].bytes, bytes);
  assert.deepEqual(f.calls.decode, [f.calls.files[0].uri], "Native decoding must read the local file rather than fetch the CDN URL");
  assert.deepEqual(f.calls.persist, [{ uri: f.calls.files[0].uri, key: URL }]);
  assert.equal(f.calls.files[0].deletions, 1);
  assert.equal(loaded.releases, 0, "The returned decoded image is still owned by the caller");
  loaded.release();
});

test("a readable absolute disk-cache path avoids all network and temporary-file work", async () => {
  const f = fixture({ cachedPath: () => "/data/user/0/app/cache/image.webp" });
  const loaded = await f.load(URL, new AbortController().signal);
  assert.equal(loaded, f.image);
  assert.deepEqual(f.calls.decode, ["file:///data/user/0/app/cache/image.webp"]);
  assert.equal(f.calls.fetch.length, 0);
  assert.equal(f.calls.files.length, 0);
  assert.equal(f.calls.persist.length, 0);
  loaded.release();
});

test("an unreadable cached image falls back to its same CDN URL and replaces that cache key", async () => {
  const image = resource();
  const f = fixture({
    cachedPath: () => "file:///cache/corrupt.webp",
    decode: uri => {
      if (uri === "file:///cache/corrupt.webp") throw new Error("corrupt cached image");
      return image;
    },
  });
  const loaded = await f.load(URL, new AbortController().signal); await flush();
  assert.equal(loaded, image);
  assert.equal(f.calls.fetch[0].url, URL);
  assert.deepEqual(f.calls.decode, ["file:///cache/corrupt.webp", f.calls.files[0].uri]);
  assert.equal(f.calls.persist[0].key, URL);
  assert.equal(f.calls.files[0].deletions, 1);
  loaded.release();
});

test("invalid cached dimensions release the invalid resource before a fresh download", async () => {
  const invalid = resource(0, 400), good = resource();
  const f = fixture({ cachedPath: () => "/cache/invalid.webp", decode: uri => uri === "file:///cache/invalid.webp" ? invalid : good });
  assert.equal(await f.load(URL, new AbortController().signal), good);
  await flush();
  assert.equal(invalid.releases, 1);
  assert.equal(f.calls.fetch.length, 1);
  assert.equal(f.calls.files[0].deletions, 1);
  good.release();
});

test("failed disk-cache lookup still permits a CDN download", async () => {
  const f = fixture({ cachedPath: () => { throw new Error("cache unavailable"); } });
  const loaded = await f.load(URL, new AbortController().signal); await flush();
  assert.equal(loaded, f.image);
  assert.equal(f.calls.fetch.length, 1);
  assert.equal(f.calls.files[0].deletions, 1);
  loaded.release();
});

for (const scenario of ["http-failure", "declared-oversize", "stream-oversize", "empty"]) {
  test(`${scenario}: rejected response cannot create or cache a native image`, async () => {
    let cancelled = false;
    const f = fixture({ respond: () => {
      const body = new ReadableStream({
        start(controller) {
          if (scenario === "stream-oversize") {
            controller.enqueue(new Uint8Array(12 * 1024 * 1024));
            controller.enqueue(new Uint8Array(1));
          } else if (scenario !== "empty") controller.enqueue(bytes);
          controller.close();
        },
        cancel() { cancelled = true; },
      });
      return new Response(body, {
        status: scenario === "http-failure" ? 503 : 200,
        headers: scenario === "declared-oversize" ? { "content-length": String(12 * 1024 * 1024 + 1) } : {},
      });
    } });
    await assert.rejects(f.load(URL, new AbortController().signal), /unavailable|too large|byte limit|empty/);
    assert.equal(f.calls.files.length, 0);
    assert.equal(f.calls.decode.length, 0);
    assert.equal(f.calls.persist.length, 0);
    if (scenario === "http-failure" || scenario === "declared-oversize") assert.equal(cancelled, true);
  });
}

test("corrupt downloaded bytes remove their temporary file and cannot enter the persistent image cache", async () => {
  const f = fixture({ decode: () => { throw new Error("decoder rejected corrupt bytes"); } });
  await assert.rejects(f.load(URL, new AbortController().signal), /corrupt bytes/);
  assert.equal(f.calls.files.length, 1);
  assert.equal(f.calls.files[0].deletions, 1);
  assert.equal(f.calls.persist.length, 0);
});

test("invalid downloaded dimensions release the image and remove the temporary file", async () => {
  const image = resource(900, 0);
  const f = fixture({ decode: () => image });
  await assert.rejects(f.load(URL, new AbortController().signal), /dimensions are invalid/);
  assert.equal(image.releases, 1);
  assert.equal(f.calls.files[0].deletions, 1);
  assert.equal(f.calls.persist.length, 0);
});

test("temporary-file write failure cleans up before native decoding", async () => {
  const f = fixture({ write: () => { throw new Error("disk full"); } });
  await assert.rejects(f.load(URL, new AbortController().signal), /disk full/);
  assert.equal(f.calls.files[0].deletions, 1);
  assert.equal(f.calls.decode.length, 0);
  assert.equal(f.calls.persist.length, 0);
});

test("abort cancels a stalled response reader even if stream cancellation never settles", async () => {
  let cancels = 0;
  const f = fixture({ respond: () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes); },
    cancel() { cancels++; return new Promise(() => {}); },
  })) });
  const controller = new AbortController();
  const pending = f.load(URL, controller.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await flush();
  controller.abort();
  await rejected;
  assert.equal(cancels, 1);
  assert.equal(f.calls.files.length, 0);
  assert.equal(f.calls.decode.length, 0);
});

test("cancelling a stalled stream frees the cache slot for the next selected photo", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = 0;
  const f = fixture({ respond: url => url.endsWith("stalled") ? new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes); },
    cancel() { cancelled++; },
  })) : new Response(bytes) });
  const cache = new GalleryPreviewCache(f.load, { concurrency: 1, retained: 8, timeoutMs: 1000, automaticRetries: 0 });
  cache.subscribe("https://images.souqhamad.com/stalled", () => {});
  cache.subscribe(URL, () => {}, 20);
  await flush();
  assert.equal(f.calls.fetch.length, 1);
  t.mock.timers.tick(1000); await flush();
  assert.equal(cancelled, 1);
  assert.equal(f.calls.fetch.length, 2);
  assert.equal(cache.snapshot(URL).status, "loaded");
  assert.equal(cache.snapshot(URL).resource, f.image);
  assert.equal(f.calls.files[0].deletions, 1);
  cache.dispose();
  assert.equal(f.image.releases, 1);
});

test("abort during delayed local decoding releases the late resource and deletes its source", async () => {
  const gate = deferred(), image = resource();
  const f = fixture({ decode: () => gate.promise });
  const controller = new AbortController();
  const pending = f.load(URL, controller.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await flush();
  assert.equal(f.calls.decode.length, 1);
  controller.abort(); gate.resolve(image);
  await rejected;
  assert.equal(image.releases, 1);
  assert.equal(f.calls.files[0].deletions, 1);
  assert.equal(f.calls.persist.length, 0);
});

test("abort while writing a file cleans up without starting native decoding", async () => {
  const gate = deferred();
  const f = fixture({ write: () => gate.promise });
  const controller = new AbortController();
  const pending = f.load(URL, controller.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await flush();
  assert.equal(f.calls.files.length, 1);
  controller.abort(); gate.resolve();
  await rejected;
  assert.equal(f.calls.files[0].deletions, 1);
  assert.equal(f.calls.decode.length, 0);
});

test("a slow disk-cache copy does not delay displaying the decoded image or remove its source prematurely", async () => {
  const gate = deferred();
  const f = fixture({ persist: () => gate.promise });
  const loaded = await f.load(URL, new AbortController().signal);
  assert.equal(loaded, f.image);
  assert.equal(f.calls.files[0].deletions, 0);
  await flush();
  assert.equal(f.calls.persist.length, 1);
  gate.resolve(); await flush();
  assert.equal(f.calls.files[0].deletions, 1);
  loaded.release();
});

test("disk-cache persistence failure still returns the decoded photo and cleans its temporary source", async () => {
  const f = fixture({ persist: () => { throw new Error("disk-cache copy failed"); } });
  const loaded = await f.load(URL, new AbortController().signal); await flush();
  assert.equal(loaded, f.image);
  assert.equal(loaded.releases, 0);
  assert.equal(f.calls.files[0].deletions, 1);
  loaded.release();
});

for (const uri of ["file:///cache/legacy.webp", "data:image/webp;base64,fixture"]) {
  test(`local preview ${uri.split(":")[0]} uses no remote transfer or temporary copy`, async () => {
    const f = fixture();
    const loaded = await f.load(uri, new AbortController().signal);
    assert.deepEqual(f.calls.decode, [uri]);
    assert.equal(f.calls.cache.length, 0);
    assert.equal(f.calls.fetch.length, 0);
    assert.equal(f.calls.files.length, 0);
    loaded.release();
  });
}

test("abort during cached-path discovery prevents both decode and download", async () => {
  const gate = deferred();
  const f = fixture({ cachedPath: () => gate.promise });
  const controller = new AbortController();
  const pending = f.load(URL, controller.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  controller.abort(); gate.resolve("/cache/late.webp");
  await rejected;
  assert.equal(f.calls.decode.length, 0);
  assert.equal(f.calls.fetch.length, 0);
});