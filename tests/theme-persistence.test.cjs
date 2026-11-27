const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function load(filename, mocks) {
  const exports = {};
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(javascript, { exports, module: { exports }, require: name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    throw Error(`Unexpected dependency: ${name}`);
  } });
  return exports;
}
function harness({ read = async () => "system", write = async () => {}, platform = "android" } = {}) {
  const slots = [];
  const effects = [];
  const nativeAppearance = [];
  let cursor = 0;
  const theme = load(path.resolve(__dirname, "../src/ui/theme.ts"), {});
  const react = {
    createContext: () => ({ Provider: "Provider" }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useMemo(factory) { cursor++; return factory(); },
    useCallback(fn) { cursor++; return fn; },
    useEffect(fn, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        previous?.cleanup?.();
        slots[index] = { dependencies };
        effects.push(() => { slots[index].cleanup = fn(); });
      }
    },
  };
  const mod = load(path.resolve(__dirname, "../src/ui/theme-context.tsx"), {
    react,
    "react/jsx-runtime": { jsx: (type, props) => ({ type, props }) },
    "react-native": { Platform: { OS: platform }, useColorScheme: () => "light", Appearance: { setColorScheme: value => nativeAppearance.push(value) } },
    "expo-secure-store": { getItemAsync: read, setItemAsync: write },
    "./theme": theme,
  });
  return {
    nativeAppearance,
    render() { cursor = 0; const tree = mod.AppThemeProvider({ children: null }); return tree.props.value; },
    flush() { for (const effect of effects.splice(0)) effect(); },
  };
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("late appearance hydration cannot replace a choice already made", async () => {
  const pending = deferred();
  const app = harness({ read: () => pending.promise });
  const initial = app.render();
  app.flush();
  initial.setPreference("light");
  pending.resolve("dark");
  await settle();
  const result = app.render();
  assert.equal(result.ready, true);
  assert.equal(result.preference, "light");
  assert.equal(result.scheme, "light");
});

test("rapid choices are persisted in order so restart restores the last choice", async () => {
  const firstWrite = deferred();
  const writes = [];
  const app = harness({ write: async (_key, value) => {
    if (!writes.length) { writes.push(`start:${value}`); await firstWrite.promise; }
    writes.push(`saved:${value}`);
  } });
  app.render(); app.flush(); await settle();
  const ready = app.render(); app.flush();
  ready.setPreference("dark");
  ready.setPreference("light");
  await settle();
  assert.deepEqual(writes, ["start:dark"]);
  firstWrite.resolve(); await settle();
  assert.deepEqual(writes, ["start:dark", "saved:dark", "saved:light"]);
  assert.equal(app.render().preference, "light");
});

test("unavailable storage releases startup and leaves switching usable", async () => {
  const app = harness({ read: async () => { throw Error("fixture unavailable"); }, write: async () => { throw Error("fixture unavailable"); } });
  app.render(); app.flush(); await settle();
  const ready = app.render(); app.flush();
  assert.equal(ready.ready, true);
  assert.equal(ready.preference, "system");
  ready.setPreference("dark"); await settle();
  const dark = app.render(); app.flush();
  assert.equal(dark.scheme, "dark");
  assert.equal(app.nativeAppearance.at(-1), "dark");
  dark.setPreference("system"); await settle(); app.render(); app.flush();
  assert.equal(app.nativeAppearance.at(-1), "auto");
});
