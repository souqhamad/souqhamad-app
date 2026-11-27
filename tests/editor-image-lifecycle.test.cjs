const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

// Execute the real component with native display/error events and controlled
// timers. This checks device-side handoff, not just upload success callbacks.
const filename = require("node:path").resolve(__dirname, "../src/features/listing-editor/editor-image.tsx");
const source = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = source.statements.filter(ts.isFunctionDeclaration);
const code = ts.transpileModule(functions.map(fn => fn.getText(source)).join("\n") +
  "\nmodule.exports = { EditorImage, EditorImageContent };", {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function mount(input) {
  let props = { active: true, style: { width: 122, height: 122 }, accessibilityLabel: "photo", ...input };
  let hooks = [], pending = [], cursor = 0, dirty = false, tree, mountedKey, now = 0, nextId = 0, writes = 0;
  const timers = new Map();
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
  const effect = (fn, deps) => {
    const index = cursor++, previous = hooks[index];
    if (!previous || !equal(previous.deps, deps)) pending.push(() => {
      previous?.cleanup?.(); hooks[index] = { deps, cleanup: fn() };
    });
  };
  const jsx = (type, value, key) => ({ type, props: value ?? {}, key });
  const module = { exports: {} };
  vm.runInNewContext(code, {
    exports: module.exports, module,
    require: name => { assert.equal(name, "react/jsx-runtime"); return { jsx, jsxs: jsx }; },
    useState: initial => {
      const index = cursor++;
      hooks[index] ||= { value: initial };
      const slot = hooks[index];
      return [slot.value, value => {
        writes++;
        const next = typeof value === "function" ? value(slot.value) : value;
        if (next !== slot.value) { slot.value = next; dirty = true; }
      }];
    },
    useRef: initial => { const index = cursor++; return hooks[index] ||= { current: initial }; },
    useEffect: effect, useLayoutEffect: effect,
    useTheme: () => ({ colors: { primary: "green", surface: "white" } }),
    setTimeout: (fn, ms) => { const id = ++nextId; timers.set(id, { fn, due: now + ms }); return id; },
    clearTimeout: id => timers.delete(id),
    Image: "Image", View: "View", Pressable: "Retry", ActivityIndicator: "Spinner", Icon: "Icon", AppText: "Text",
    StyleSheet: { absoluteFill: "fill" }, styles: { frame: "frame", center: "center", retry: "retry" },
  });
  const cleanup = () => hooks.forEach(hook => hook?.cleanup?.());
  const render = () => {
    let count = 0;
    do {
      assert.ok(++count < 15, "image effects must settle");
      dirty = false;
      const wrapper = module.exports.EditorImage(props);
      if (wrapper.key !== mountedKey) { cleanup(); hooks = []; pending = []; mountedKey = wrapper.key; }
      cursor = 0;
      tree = module.exports.EditorImageContent(wrapper.props);
      while (pending.length) pending.shift()();
    } while (dirty);
  };
  const nodes = (type, node = tree) => {
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap(child => nodes(type, child));
    return [...(node.type === type ? [node] : []), ...nodes(type, node.props.children ?? null)];
  };
  render();
  return {
    nodes,
    event: fn => { fn(); render(); },
    update: next => { props = { ...props, ...next }; render(); },
    tick: ms => {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.fn(); }
      render();
    },
    unmount: cleanup,
    get timerCount() { return timers.size; },
    get writes() { return writes; },
  };
}
const image = (h, url) => h.nodes("Image").find(node => node.props.source === url);

test("the local preview stays mounted until the delivery image actually displays", () => {
  const h = mount({ sources: ["display"], localUri: "local" });
  h.event(() => image(h, "local").props.onDisplay());
  const key = image(h, "local").key;
  h.event(() => image(h, "display").props.onError()); h.tick(700);
  assert.equal(image(h, "local").key, key, "retry must not blank an already visible preview");
  h.event(() => image(h, "display").props.onDisplay());
  assert.equal(image(h, "local"), undefined);
  assert.equal(h.nodes("Spinner").length, 0);
  assert.equal(h.timerCount, 0);
  h.unmount();
});

test("each distinct delivery source retries once then shows a manual retry instead of a blank tile", () => {
  const h = mount({ sources: ["display", "display", "thumbnail"] });
  for (const url of ["display", "display", "thumbnail", "thumbnail"]) {
    assert.ok(image(h, url));
    h.event(() => image(h, url).props.onError()); h.tick(700);
  }
  assert.equal(h.nodes("Image").length, 0);
  assert.equal(h.nodes("Retry").length, 1);
  assert.equal(h.timerCount, 0);
  h.tick(60_000);
  assert.equal(h.nodes("Image").length, 0, "failure must not start an unbounded request loop");
  h.event(h.nodes("Retry")[0].props.onPress);
  assert.ok(image(h, "display"));
  h.unmount();
});

test("a stalled delivery does not remove the local image and watchdog retries are bounded", () => {
  const h = mount({ sources: ["display"], localUri: "local" });
  h.event(() => image(h, "local").props.onDisplay());
  h.tick(15_000); h.tick(700); h.tick(15_000); h.tick(700);
  assert.ok(image(h, "local"));
  assert.equal(h.nodes("Retry").length, 1);
  assert.equal(h.timerCount, 0);
  h.unmount();
});

test("a stale load or error cannot advance a newer attempt or a different photo", () => {
  const h = mount({ sources: ["old"] });
  const old = image(h, "old");
  h.event(old.props.onError); h.tick(700);
  const key = image(h, "old").key;
  h.event(old.props.onDisplay); h.event(old.props.onError);
  assert.equal(image(h, "old").key, key);
  assert.equal(h.timerCount, 1, "old display event must not mark the retry as loaded");
  h.update({ sources: ["new"], localUri: "new-local" });
  const writes = h.writes;
  h.event(old.props.onDisplay); h.event(old.props.onError);
  assert.equal(h.writes, writes, "callbacks from an unmounted account/photo must be ignored");
  assert.ok(image(h, "new-local"));
  h.unmount();
});

test("hidden editor surfaces stop retry timers and resume when visible", () => {
  const h = mount({ sources: ["display"] });
  h.event(() => image(h, "display").props.onError());
  const key = image(h, "display").key;
  h.update({ active: false }); h.tick(60_000);
  assert.equal(h.timerCount, 0);
  assert.equal(image(h, "display").key, key);
  h.update({ active: true }); h.tick(700);
  assert.notEqual(image(h, "display").key, key);
  h.unmount(); assert.equal(h.timerCount, 0);
});

test("local-only photos never start a network watchdog and a failed local file can retry", () => {
  const h = mount({ sources: [], localUri: "local" });
  assert.equal(h.timerCount, 0);
  h.event(() => image(h, "local").props.onError());
  assert.equal(h.nodes("Retry").length, 1);
  h.event(h.nodes("Retry")[0].props.onPress);
  assert.ok(image(h, "local"));
  h.unmount();
});
