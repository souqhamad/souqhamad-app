const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const categories = [
  { id: "cars", label: "سيارات", group: "vehicles", options: [{ id: "toyota", label: "تويوتا" }], carModels: { toyota: [{ id: "camry", label: "كامري" }] } },
  { id: "phones", label: "هواتف", group: "electronics", options: [{ id: "apple", label: "آبل" }] },
];
function clock() {
  let now = 0;
  let sequence = 0;
  const jobs = new Map();
  return {
    setTimeout(callback, delay) { const id = ++sequence; jobs.set(id, { callback, due: now + delay }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const next = [...jobs.entries()].filter(([, job]) => job.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        now = next[1].due;
        jobs.delete(next[0]);
        void next[1].callback();
      }
      now = target;
    },
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const json = value => JSON.parse(JSON.stringify(value));
function source(runtimeClock, react = {}, api = {}) {
  const filename = path.resolve(__dirname, "../src/features/listing-editor/use-category-suggestion.ts");
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, { module, exports: module.exports, AbortController,
    setTimeout: runtimeClock.setTimeout, clearTimeout: runtimeClock.clearTimeout,
    require: id => {
      if (id === "react") return react;
      if (id === "../../core/api") return { api };
      throw new Error(`Unexpected dependency ${id}`);
    },
  }, { filename });
  return module.exports;
}
function harness() {
  const timer = clock();
  const requests = [], applied = [], feedback = [];
  const { createCategorySuggestionSession } = source(timer);
  const session = createCategorySuggestionSession({
    request: (title, signal) => { const response = deferred(); requests.push({ title, signal, ...response }); return response.promise; },
    onSuggestion: (suggestion, scope) => applied.push({ suggestion, scope }),
    onFeedback: value => feedback.push(value),
  });
  const update = (changes = {}) => session.update({ ownerId: "owner-a", title: "سيارة للبيع", categories, enabled: true, ...changes });
  return { timer, requests, applied, feedback, session, update };
}

test("classification waits 600ms after the last title and validates the returned car selection", async () => {
  const h = harness();
  h.update({ title: "عنوان سابق" }); h.timer.advance(500);
  h.update({ title: "  تويوتا كامري  " }); h.timer.advance(599);
  assert.equal(h.requests.length, 0);
  h.timer.advance(1);
  assert.equal(h.requests[0].title, "تويوتا كامري");
  assert.equal(h.requests[0].signal.aborted, false);
  h.requests[0].resolve({ status: "suggested", category: "cars", categoryOption: "toyota", carModel: "camry" });
  await flush();
  assert.deepEqual(json(h.applied), [{ suggestion: { category: "cars", categoryOption: "toyota", carModel: "camry" }, scope: { ownerId: "owner-a", title: "تويوتا كامري" } }]);
  assert.equal(h.feedback.at(-1).status, "suggested");
});

test("a title change aborts and ignores an older response even when it resolves last", async () => {
  const h = harness();
  h.update(); h.timer.advance(600);
  h.update({ title: "هاتف للبيع" }); h.timer.advance(600);
  assert.equal(h.requests[0].signal.aborted, true);
  h.requests[1].resolve({ status: "suggested", category: "phones", categoryOption: "apple" }); await flush();
  h.requests[0].resolve({ status: "suggested", category: "cars" }); await flush();
  assert.equal(h.applied.length, 1);
  assert.equal(h.applied[0].suggestion.category, "phones");
  assert.equal(h.applied[0].scope.title, "هاتف للبيع");
});

test("changing owner or leaving the editor prevents old suggestions from reaching the form", async () => {
  const h = harness();
  h.update(); h.timer.advance(600);
  h.update({ ownerId: "owner-b" }); h.timer.advance(600);
  h.requests[0].resolve({ status: "suggested", category: "cars" }); await flush();
  assert.equal(h.applied.length, 0);
  h.requests[1].resolve({ status: "suggested", category: "phones" }); await flush();
  assert.equal(h.applied[0].scope.ownerId, "owner-b");
  h.update({ ownerId: "owner-b", title: "عنوان آخر" }); h.timer.advance(600);
  h.session.cancel();
  assert.equal(h.requests[2].signal.aborted, true);
  h.requests[2].resolve({ status: "suggested", category: "cars" }); await flush();
  assert.equal(h.applied.length, 1);
});

test("manual category, brand or model selection locks both pending and future AI suggestions", async () => {
  for (const milliseconds of [300, 600]) {
    const h = harness();
    h.update(); h.timer.advance(milliseconds);
    h.session.lock();
    if (h.requests.length) {
      assert.equal(h.requests[0].signal.aborted, true);
      h.requests[0].resolve({ status: "suggested", category: "cars", categoryOption: "toyota", carModel: "camry" });
    }
    h.update({ title: "عنوان مختلف" }); h.timer.advance(1200); await flush();
    assert.equal(h.applied.length, 0);
    assert.equal(h.requests.length, milliseconds === 600 ? 1 : 0);
  }
});

test("saved or unfocused editors make no request and cancel an in-flight suggestion", async () => {
  const h = harness();
  h.update({ enabled: false }); h.timer.advance(1200);
  assert.equal(h.requests.length, 0);
  h.update(); h.timer.advance(600);
  h.update({ enabled: false });
  assert.equal(h.requests[0].signal.aborted, true);
  h.requests[0].resolve({ status: "suggested", category: "cars" }); await flush();
  assert.equal(h.applied.length, 0);
});

test("uncertain, unavailable and unknown category results leave manual classification untouched", async () => {
  const h = harness();
  for (const response of [{ status: "uncertain", category: null }, { status: "unavailable", category: null }, { status: "suggested", category: "invented" }, null]) {
    h.update(); h.timer.advance(600); h.requests.at(-1).resolve(response); await flush();
    assert.equal(h.feedback.at(-1).status, "idle");
  }
  assert.equal(h.applied.length, 0);
  h.update(); h.timer.advance(600); h.requests.at(-1).reject(Object.assign(new Error("not configured"), { status: 503 })); await flush();
  assert.equal(h.feedback.at(-1).status, "idle");
  assert.equal(h.applied.length, 0);
});

test("untrusted options and models are cleared rather than copied into another category", async () => {
  const h = harness();
  for (const [response, expected] of [
    [{ category: "cars", categoryOption: "invented", carModel: "camry" }, { category: "cars", categoryOption: "", carModel: "" }],
    [{ category: "cars", categoryOption: "toyota", carModel: "invented" }, { category: "cars", categoryOption: "toyota", carModel: "" }],
    [{ category: "phones", categoryOption: "apple", carModel: "camry" }, { category: "phones", categoryOption: "apple", carModel: "" }],
  ]) {
    h.update(); h.timer.advance(600); h.requests.at(-1).resolve({ status: "suggested", ...response }); await flush();
    assert.deepEqual(json(h.applied.at(-1).suggestion), expected);
  }
});

test("the hook posts only the title to the existing API and cleanup aborts its signal", async () => {
  const timer = clock();
  const effects = [], requests = [], applied = [];
  const response = deferred();
  const react = {
    useEffect: effect => effects.push(effect),
    useLayoutEffect: effect => effects.push(effect),
    useState: initial => [typeof initial === "function" ? initial() : initial, () => {}],
  };
  const api = { post: (url, body, options) => { requests.push({ url, body, options }); return response.promise; } };
  const { useCategorySuggestion } = source(timer, react, api);
  useCategorySuggestion({ ownerId: "owner-a", title: "هاتف", categories, enabled: true, onSuggestion: value => applied.push(value) });
  const cleanups = effects.map(effect => effect());
  timer.advance(600);
  assert.equal(requests[0].url, "/api/marketplace/listing-category");
  assert.deepEqual(json(requests[0].body), { title: "هاتف" });
  assert.equal(Object.hasOwn(requests[0].options, "aiConsent"), false);
  for (const cleanup of cleanups) cleanup?.();
  assert.equal(requests[0].options.signal.aborted, true);
  response.resolve({ status: "suggested", category: "phones" }); await flush();
  assert.equal(applied.length, 0);
});

test("classification can be locally disabled and re-enabled without changing chat consent", async () => {
  const h = harness();
  h.update({ enabled: false }); h.timer.advance(1200);
  assert.equal(h.requests.length, 0);
  h.update(); h.timer.advance(600);
  h.update({ enabled: false });
  assert.equal(h.requests[0].signal.aborted, true);
  h.requests[0].resolve({ status: "suggested", category: "cars" }); await flush();
  assert.equal(h.applied.length, 0);
  h.update(); h.timer.advance(600);
  h.requests[1].resolve({ status: "suggested", category: "phones" }); await flush();
  assert.equal(h.applied.length, 1);
  assert.equal(h.applied[0].suggestion.category, "phones");
});
