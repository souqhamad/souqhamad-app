const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { QueryClient, QueryObserver, InfiniteQueryObserver, hashKey } = require("@tanstack/react-query");
const reads = require("../src/core/visible-query-read.ts");

const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  let focused = true, observer, stop, effects = [];
  const state = { currentState: "active", addEventListener: () => ({ remove() {} }) };
  const queryHook = Observer => options => {
    if (!observer) { observer = new Observer(client, options); stop = observer.subscribe(() => {}); }
    else observer.setOptions(options);
    return observer.getCurrentResult();
  };
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/core/visible-query.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, require(name) {
    if (name === "react") return { useCallback: fn => fn, useEffect: fn => effects.push(fn), useSyncExternalStore: (_subscribe, snapshot) => snapshot() };
    if (name === "react-native") return { AppState: state };
    if (name === "expo-router") return { useIsFocused: () => focused };
    if (name === "@tanstack/react-query") return { useQuery: queryHook(QueryObserver), useInfiniteQuery: queryHook(InfiniteQueryObserver), useQueryClient: () => client, hashKey };
    if (name === "./visible-query-read") return reads;
    throw Error(`Unexpected dependency ${name}`);
  } });
  return {
    client,
    focus(value) { focused = value; },
    foreground(value) { state.currentState = value ? "active" : "background"; },
    render(options, infinite = false) {
      effects = [];
      const result = (infinite ? exports.useVisibleInfiniteQuery : exports.useVisibleQuery)(options);
      for (const effect of effects) effect();
      return result;
    },
    close() { stop?.(); client.clear(); },
  };
}

test("the actual visible-query hook cancels on blur and reconciles invalidated data on return", async () => {
  const app = harness(); let requests = 0, aborted = false, release;
  const waiting = new Promise(resolve => { release = resolve; });
  const options = { queryKey: ["listing", "ad"], queryFn: async ({ signal }) => {
    const number = ++requests;
    signal.addEventListener("abort", () => { aborted = true; });
    if (number === 1) await waiting;
    return number;
  } };
  app.render(options); assert.equal(requests, 1);
  app.focus(false); let hidden = app.render(options); await tick();
  assert.equal(aborted, true);
  await hidden.refetch(); assert.equal(requests, 1, "hidden imperative refresh is deferred");
  app.focus(true); app.render(options); await tick();
  assert.equal(requests, 2);
  assert.equal(app.render(options).data, 2);
  app.foreground(false); hidden = app.render(options);
  await app.client.invalidateQueries({ queryKey: options.queryKey });
  await hidden.refetch(); assert.equal(requests, 2);
  app.foreground(true); app.render(options); await tick();
  assert.equal(requests, 3);
  release(); app.close();
});

test("hidden pagination never starts GET and returning keeps cached pages before reconciliation", async () => {
  const app = harness(); let requests = 0;
  const options = { queryKey: ["account", "owner", "favorites"], initialPageParam: 1,
    initialData: { pages: [{ ids: ["first"], next: 2 }], pageParams: [1] },
    getNextPageParam: page => page.next,
    queryFn: async ({ pageParam }) => { requests++; return { ids: [pageParam === 1 ? "new-first" : "second"], next: pageParam === 1 ? 2 : undefined }; },
  };
  app.render(options, true);
  app.focus(false); const hidden = app.render(options, true);
  await hidden.fetchNextPage(); assert.equal(requests, 0);
  assert.deepEqual(app.client.getQueryData(options.queryKey).pages[0].ids, ["first"]);
  app.focus(true); app.render(options, true); await tick();
  const visible = app.render(options, true);
  assert.equal(requests, 1);
  await visible.fetchNextPage();
  assert.equal(requests, 2);
  assert.deepEqual(app.client.getQueryData(options.queryKey).pages.flatMap(page => page.ids), ["new-first", "second"]);
  app.close();
});
