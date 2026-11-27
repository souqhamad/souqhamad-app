const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(refreshers) {
  const slots = [];
  const effects = [];
  const stateUpdates = [];
  let cursor = 0;
  const exports = {};
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = value; stateUpdates.push(value); }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useCallback(fn) { cursor++; return fn; },
    useEffect(fn) { const index = cursor++; if (!(index in slots)) { slots[index] = true; effects.push(fn()); } },
  };
  const filename = path.resolve(__dirname, "../src/features/marketplace/use-market-refresh.ts");
  const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, require: name => {
    if (name === "react") return react;
    throw Error(`Unexpected dependency: ${name}`);
  } });
  return {
    stateUpdates,
    render() { cursor = 0; return exports.useMarketRefresh(refreshers); },
    unmount() { for (const cleanup of effects) cleanup?.(); },
  };
}

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("background refetches leave the native refresh indicator inactive", async () => {
  const listings = deferred();
  const bootstrap = deferred();
  const refreshers = { refreshListings: () => listings.promise, refreshBootstrap: () => bootstrap.promise };
  const app = harness(refreshers);
  assert.equal(app.render().refreshing, false);
  const background = Promise.all([refreshers.refreshListings(), refreshers.refreshBootstrap()]);
  assert.equal(app.render().refreshing, false);
  listings.resolve(); bootstrap.resolve(); await background;
  assert.equal(app.render().refreshing, false);
  assert.deepEqual(app.stateUpdates, []);
});

test("a user pull stays active until listings and settings both finish", async () => {
  const listings = deferred();
  const bootstrap = deferred();
  const app = harness({ refreshListings: () => listings.promise, refreshBootstrap: () => bootstrap.promise });
  const refresh = app.render().onRefresh();
  assert.equal(app.render().refreshing, true);
  listings.resolve(); await settle();
  assert.equal(app.render().refreshing, true);
  bootstrap.resolve(); await refresh;
  assert.equal(app.render().refreshing, false);
});

test("repeated pull events do not restart or overlap the active refresh", async () => {
  const listings = deferred();
  let calls = 0;
  const app = harness({ refreshListings: () => { calls++; return listings.promise; }, refreshBootstrap: async () => {} });
  const refresh = app.render().onRefresh();
  await app.render().onRefresh(); await settle();
  assert.equal(calls, 1);
  assert.equal(app.render().refreshing, true);
  listings.resolve(); await refresh;
  await app.render().onRefresh();
  assert.equal(calls, 2);
  assert.equal(app.render().refreshing, false);
});

test("a failed query releases the gesture after the other query settles and permits retry", async () => {
  const bootstrap = deferred();
  let calls = 0;
  const app = harness({ refreshListings: async () => { calls++; throw Error("offline"); }, refreshBootstrap: () => bootstrap.promise });
  const refresh = app.render().onRefresh();
  await settle();
  assert.equal(app.render().refreshing, true);
  bootstrap.resolve(); await refresh;
  assert.equal(app.render().refreshing, false);
  await app.render().onRefresh();
  assert.equal(calls, 2);
});

test("finishing a pull after leaving the screen does not update unmounted state", async () => {
  const listings = deferred();
  const app = harness({ refreshListings: () => listings.promise, refreshBootstrap: async () => {} });
  const refresh = app.render().onRefresh();
  app.unmount();
  listings.resolve(); await refresh;
  assert.deepEqual(app.stateUpdates, [true]);
});
