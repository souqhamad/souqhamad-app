import test from "node:test";
import assert from "node:assert/strict";
import { GalleryPreviewCache } from "../src/ui/gallery-preview-cache.ts";

const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function resource() {
  return { width: 900, height: 600, releases: 0, release() { this.releases++; } };
}

test("detail and viewer reuse one decoded preview, including rapid close/open", async () => {
  const gate = deferred(), image = resource();
  let loads = 0;
  const cache = new GalleryPreviewCache(() => { loads++; return gate.promise; });
  const detail = cache.subscribe("https://images.invalid/display.webp", () => {});
  const viewer = cache.subscribe("https://images.invalid/display.webp", () => {});
  await flush();
  assert.equal(loads, 1);
  gate.resolve(image);
  await flush();
  assert.equal(cache.snapshot("https://images.invalid/display.webp").resource, image);
  viewer();
  const reopen = cache.subscribe("https://images.invalid/display.webp", () => {});
  assert.equal(cache.snapshot("https://images.invalid/display.webp").resource, image);
  assert.equal(loads, 1);
  detail(); reopen(); cache.dispose();
  assert.equal(image.releases, 1);
});

test("retrying a failed URL preserves successful previews and coalesces callers", async () => {
  let failedLoads = 0;
  const good = resource(), recovered = resource();
  const cache = new GalleryPreviewCache(url => url === "good" ? Promise.resolve(good) :
    ++failedLoads === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(recovered),
    { concurrency: 3, retained: 4, timeoutMs: 15000, automaticRetries: 0 });
  cache.subscribe("good", () => {});
  cache.subscribe("failed", () => {});
  await flush();
  assert.equal(cache.snapshot("failed").status, "error");
  cache.retry("failed"); cache.retry("failed"); cache.retry("good");
  await flush();
  assert.equal(failedLoads, 2);
  assert.equal(cache.snapshot("good").resource, good);
  assert.equal(good.releases, 0);
  assert.equal(cache.snapshot("failed").resource, recovered);
  cache.dispose();
});

test("deadline aborts the loader and releases an obsolete late decode result", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = deferred(), image = resource();
  let signal;
  const cache = new GalleryPreviewCache((_url, current) => { signal = current; return gate.promise; },
    { concurrency: 3, retained: 8, timeoutMs: 15000, automaticRetries: 0 });
  cache.subscribe("hung", () => {});
  await flush();
  t.mock.timers.tick(15000);
  assert.equal(signal.aborted, true);
  assert.equal(cache.snapshot("hung").status, "stalled");
  gate.resolve(image);
  await flush();
  assert.equal(cache.snapshot("hung").status, "stalled");
  assert.equal(image.releases, 1);
  cache.dispose();
});

test("a timed out request retries automatically without accepting its obsolete result", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const old = deferred(), stale = resource(), fresh = resource();
  let loads = 0;
  const cache = new GalleryPreviewCache(() => ++loads === 1 ? old.promise : Promise.resolve(fresh));
  cache.subscribe("same", () => {});
  await flush();
  t.mock.timers.tick(15000);
  assert.equal(cache.snapshot("same").status, "stalled");
  t.mock.timers.tick(600); await flush();
  assert.equal(cache.snapshot("same").resource, fresh);
  assert.equal(loads, 2);
  old.resolve(stale);
  await flush();
  assert.equal(stale.releases, 1);
  assert.equal(cache.snapshot("same").resource, fresh);
  assert.equal(loads, 2);
  cache.dispose();
});

test("three stalled transfers cannot block the selected fourth image or exceed transfer concurrency", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [], signals = [];
  let running = 0, maximum = 0;
  const selected = resource();
  const cache = new GalleryPreviewCache((url, signal) => {
    calls.push(url); signals.push(signal); running++; maximum = Math.max(maximum, running);
    if (url === "eighth") { running--; return Promise.resolve(selected); }
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { running--; reject(new Error("aborted")); }, { once: true }));
  });
  cache.warm(["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"]);
  await flush();
  assert.deepEqual(calls, ["first", "second", "third"]);
  cache.subscribe("eighth", () => {}, 20);
  t.mock.timers.tick(15000); await flush();
  assert.equal(calls[3], "eighth", "The visible request overtakes all waiting warm-ups");
  assert.equal(cache.snapshot("eighth").resource, selected);
  assert.ok(signals.slice(0, 3).every(signal => signal.aborted));
  assert.ok(maximum <= 3, `At most three abortable transfers may run, saw ${maximum}`);
  cache.dispose(); await flush();
  assert.equal(running, 0);
});

test("queued previews get their own deadline only after their transfer starts", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests = [];
  const cache = new GalleryPreviewCache((_url, signal) => {
    const gate = deferred(); requests.push({ ...gate, signal }); return gate.promise;
  }, { concurrency: 2, retained: 8, timeoutMs: 15000, automaticRetries: 0 });
  for (const url of ["a", "b", "c", "d"]) cache.subscribe(url, () => {});
  await flush();
  assert.equal(requests.length, 2);
  t.mock.timers.tick(15000); await flush();
  assert.equal(requests.length, 4);
  assert.equal(cache.snapshot("a").status, "stalled");
  assert.equal(cache.snapshot("b").status, "stalled");
  assert.equal(cache.snapshot("c").status, "loading");
  assert.equal(cache.snapshot("d").status, "loading");
  assert.ok(requests.slice(0, 2).every(request => request.signal.aborted));
  assert.ok(requests.slice(2).every(request => !request.signal.aborted));
  t.mock.timers.tick(14999);
  assert.equal(cache.snapshot("c").status, "loading");
  requests[2].resolve(resource()); requests[3].resolve(resource()); await flush();
  assert.equal(cache.snapshot("c").status, "loaded");
  assert.equal(cache.snapshot("d").status, "loaded");
  cache.dispose();
  requests[0].resolve(resource()); requests[1].resolve(resource()); await flush();
});

test("fresh viewing can recover exhausted previews while priority re-subscriptions do not restart retries", async () => {
  let loads = 0;
  const recovered = resource();
  const cache = new GalleryPreviewCache(() => ++loads === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(recovered),
    { concurrency: 3, retained: 8, timeoutMs: 15000, automaticRetries: 0 });
  const first = cache.subscribe("photo", () => {});
  await flush();
  assert.equal(cache.snapshot("photo").status, "error");
  first();
  const priorityChange = cache.subscribe("photo", () => {}, 20);
  await flush();
  assert.equal(loads, 1, "A same-commit subscription change must not cause a retry loop");
  priorityChange(); await flush();
  cache.subscribe("photo", () => {}, 20); await flush();
  assert.equal(loads, 2);
  assert.equal(cache.snapshot("photo").resource, recovered);
  cache.dispose();
});

test("LRU retention is bounded while visible resources stay protected", async () => {
  const resources = new Map();
  const cache = new GalleryPreviewCache(url => {
    const image = resource(); resources.set(url, image); return Promise.resolve(image);
  }, { concurrency: 3, retained: 1, timeoutMs: 15000 });
  const active = cache.subscribe("active", () => {});
  await flush();
  for (const url of ["old", "new"]) {
    const stop = cache.subscribe(url, () => {});
    await flush(); stop();
  }
  assert.equal(resources.get("old").releases, 1);
  assert.equal(resources.get("new").releases, 0);
  assert.equal(resources.get("active").releases, 0);
  active(); cache.dispose();
  assert.equal(resources.get("active").releases, 1);
  assert.equal(resources.get("new").releases, 1);
});

test("screen disposal aborts transfers and releases late resources without notifying removed views", async () => {
  const gate = deferred(), image = resource();
  let events = 0, signal;
  const cache = new GalleryPreviewCache((_url, current) => { signal = current; return gate.promise; });
  const stop = cache.subscribe("late", () => { events++; });
  await flush(); stop(); cache.dispose();
  assert.equal(signal.aborted, true);
  gate.resolve(image);
  await flush();
  assert.equal(image.releases, 1);
  assert.equal(events, 0);
});

test("transient failures retry automatically twice and then stop", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let loads = 0;
  const cache = new GalleryPreviewCache(() => { loads++; return Promise.reject(new Error("temporary")); });
  cache.subscribe("transient", () => {});
  await flush();
  assert.equal(loads, 1);
  t.mock.timers.tick(600); await flush();
  assert.equal(loads, 2);
  t.mock.timers.tick(1200); await flush();
  assert.equal(loads, 3);
  assert.equal(cache.snapshot("transient").status, "error");
  t.mock.timers.tick(60000); await flush();
  assert.equal(loads, 3);
  cache.dispose();
});

test("a hung transfer also has a bounded automatic retry allowance", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let loads = 0, running = 0;
  const cache = new GalleryPreviewCache((_url, signal) => {
    loads++; running++;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { running--; reject(new Error("aborted")); }, { once: true }));
  });
  cache.subscribe("hung", () => {}); await flush();
  for (const delay of [15000, 600, 15000, 1200, 15000]) { t.mock.timers.tick(delay); await flush(); }
  assert.equal(loads, 3);
  assert.equal(running, 0);
  assert.equal(cache.snapshot("hung").status, "stalled");
  t.mock.timers.tick(60000); await flush();
  assert.equal(loads, 3);
  cache.dispose();
});

test("selected preview overtakes queued warm-ups and all preloads stay bounded", async () => {
  const requests = [], gates = [];
  const cache = new GalleryPreviewCache(url => {
    requests.push(url); const gate = deferred(); gates.push(gate); return gate.promise;
  }, { concurrency: 1, retained: 8, timeoutMs: 15000 });
  cache.warm(["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ignored"]);
  await flush();
  assert.deepEqual(requests, ["first"]);
  cache.subscribe("eighth", () => {}, 20);
  gates[0].resolve(resource()); await flush();
  assert.deepEqual(requests, ["first", "eighth"]);
  for (let index = 1; index < 8; index++) { gates[index].resolve(resource()); await flush(); }
  assert.equal(requests.length, 8);
  assert.ok(!requests.includes("ignored"));
  cache.dispose();
});