const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

// Execute the real card component with controlled native failure events.
const filename = path.resolve(__dirname, "../src/ui/listing-card-image.tsx");
const source = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = source.statements.filter(node => ts.isFunctionDeclaration(node));
assert.equal(functions.length, 2);
const code = ts.transpileModule(`${functions.map(node => node.getText(source)).join("\n")}\nmodule.exports = { ListingCardImage, ListingCardImageContent };`, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function mount(props) {
  let hooks = [], pending = [], cursor = 0, dirty = false, tree, mountedKey;
  let nextTimerId = 1;
  const timers = new Map();
  let recovery = { active: true, revision: 0, networkRevision: 0 };
  const module = { exports: {} };
  const jsx = (type, props, key) => ({ type, props: props || {}, key });
  const cleanup = () => hooks.forEach(hook => hook?.cleanup?.());
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: name => {
      assert.equal(name, "react/jsx-runtime");
      return { jsx };
    },
    useState: initial => {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { value: initial };
      const hook = hooks[index];
      return [hook.value, value => {
        const next = typeof value === "function" ? value(hook.value) : value;
        if (next !== hook.value) { hook.value = next; dirty = true; }
      }];
    },
    useRef: initial => { const index = cursor++; return hooks[index] ||= { current: initial }; },
    useContext: () => recovery,
    ListingCardRecoveryContext: {},
    setTimeout: (fn, delay) => { const id = nextTimerId++; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    useLayoutEffect: (fn, deps) => {
      const index = cursor++;
      const previous = hooks[index];
      if (!previous || deps.some((value, i) => value !== previous.deps[i]))
        pending.push(() => { previous?.cleanup?.(); hooks[index] = { deps, cleanup: fn() }; });
    },
    Image: "Image", StyleSheet: { absoluteFill: "fill" },
  });
  const render = () => {
    let passes = 0;
    do {
      assert.ok(++passes < 10, "Card image selection must settle");
      dirty = false;
      const wrapper = module.exports.ListingCardImage(props);
      if (wrapper.key !== mountedKey) {
        cleanup(); hooks = []; pending = []; mountedKey = wrapper.key;
      }
      cursor = 0;
      tree = module.exports.ListingCardImageContent(wrapper.props);
      while (pending.length) pending.shift()();
    } while (dirty);
  };
  render();
  return {
    get image() { return tree?.type === "Image" ? tree : undefined; },
    get tree() { return tree; },
    event: fn => { fn(); render(); },
    update: next => { props = { ...props, ...next }; render(); },
    recover: next => { recovery = { ...recovery, ...next }; render(); },
    flushTimers: () => {
      const due = [...timers.values()]; timers.clear();
      for (const timer of due) { assert.equal(timer.delay, 350); timer.fn(); }
      render();
    },
    get timerCount() { return timers.size; },
    unmount: cleanup,
  };
}

test("a failed thumbnail falls back to the display derivative", () => {
  const h = mount({ sources: ["thumbnail", "display", "original"], fallback: "placeholder" });
  assert.equal(h.image.props.source, "thumbnail");
  h.event(h.image.props.onError);
  assert.equal(h.image.props.source, "display");
  h.unmount();
});

test("a working display image remains selected and never advances to the original", () => {
  const h = mount({ sources: ["thumbnail", "display", "original"], fallback: "placeholder" });
  h.event(h.image.props.onError);
  const key = h.image.key;
  h.update({ sources: ["thumbnail", "display", "original"] });
  assert.equal(h.image.props.source, "display");
  assert.equal(h.image.key, key);
  h.unmount();
});

test("same-URL aliases are attempted only once before the next distinct URI", () => {
  const h = mount({ sources: ["same", "same", "same", "legacy"], fallback: "placeholder" });
  h.event(h.image.props.onError);
  assert.equal(h.image.props.source, "legacy");
  h.event(h.image.props.onError);
  assert.equal(h.tree, "placeholder");
  h.unmount();
});

test("fallback is bounded by the finite list of server-provided image sources", () => {
  const h = mount({ sources: ["thumbnail", "display", "original"], fallback: "placeholder" });
  const attempted = [];
  while (h.image) {
    attempted.push(h.image.props.source);
    h.event(h.image.props.onError);
  }
  assert.deepEqual(attempted, ["thumbnail", "display", "original"]);
  assert.equal(h.tree, "placeholder");
  h.unmount();
});

test("transient cold-load failure gets one delayed bounded retry of the existing source list", () => {
  const h = mount({ sources: ["thumbnail", "display"], fallback: "placeholder" });
  h.event(h.image.props.onError);
  h.event(h.image.props.onError);
  assert.equal(h.tree, "placeholder");
  assert.equal(h.timerCount, 1);

  h.flushTimers();
  assert.equal(h.image.props.source, "thumbnail");
  h.event(h.image.props.onError);
  h.event(h.image.props.onError);
  assert.equal(h.tree, "placeholder");
  assert.equal(h.timerCount, 0, "the automatic retry must not loop when every source fails again");
  h.flushTimers();
  assert.equal(h.tree, "placeholder");
  h.unmount();
});

test("a fresh recovery snapshot cancels the delayed retry and keeps recovery bounded to current sources", () => {
  const h = mount({ sources: ["thumbnail"], fallback: "placeholder" });
  h.event(h.image.props.onError);
  assert.equal(h.timerCount, 1);
  h.recover({ revision: 1 });
  assert.equal(h.timerCount, 0);
  assert.equal(h.image.props.source, "thumbnail");
  h.unmount();
});

test("a late repeated error from an old URI cannot skip the next source", () => {
  const h = mount({ sources: ["thumbnail", "display", "original"], fallback: "placeholder" });
  const failedThumbnail = h.image.props.onError;
  h.event(failedThumbnail);
  h.event(failedThumbnail);
  assert.equal(h.image.props.source, "display");
  h.unmount();
});

test("new source URLs reset selection and ignore a removed listing image's late errors", () => {
  const h = mount({ sources: ["old-thumbnail", "old-display"], fallback: "placeholder" });
  h.event(h.image.props.onError);
  const removedImageError = h.image.props.onError;
  h.update({ sources: ["new-thumbnail", "new-display"] });
  assert.equal(h.image.props.source, "new-thumbnail");
  h.event(removedImageError);
  assert.equal(h.image.props.source, "new-thumbnail");
  h.unmount();
});

test("an empty source list shows the existing placeholder and later images can load", () => {
  const h = mount({ sources: [], fallback: "placeholder" });
  assert.equal(h.tree, "placeholder");
  h.update({ sources: ["new-thumbnail"] });
  assert.equal(h.image.props.source, "new-thumbnail");
  h.unmount();
});

test("card images retain the existing layout and transition with disk and memory caching", () => {
  const h = mount({ sources: ["thumbnail"], fallback: "placeholder" });
  assert.equal(h.image.props.style, "fill");
  assert.equal(h.image.props.contentFit, "cover");
  assert.equal(h.image.props.transition, 180);
  assert.equal(h.image.props.cachePolicy, "memory-disk");
  h.unmount();
});

test("exhausted images retry on a fresh snapshot or return to focus, but working images keep their native instance", () => {
  const h = mount({ sources: ["thumbnail", "display"], fallback: "placeholder" });
  h.event(h.image.props.onError);
  const oldError = h.image.props.onError;
  h.event(oldError);
  assert.equal(h.tree, "placeholder");
  h.recover({ revision: 1 });
  assert.equal(h.image.props.source, "thumbnail");
  h.event(oldError);
  assert.equal(h.image.props.source, "thumbnail", "a stale error cannot consume a new attempt");
  const key = h.image.key;
  h.recover({ revision: 2 });
  assert.equal(h.image.key, key, "a fresh response never resets a working photo");
  h.event(h.image.props.onError); h.event(h.image.props.onError);
  h.recover({ active: false }); assert.equal(h.tree, "placeholder");
  h.recover({ active: true }); assert.equal(h.image.props.source, "thumbnail");
  h.unmount();
});

test("connectivity returning retries an exhausted card without refetching or changing focus", () => {
  const h = mount({ sources: ["thumbnail", "display"], fallback: "placeholder" });
  h.event(h.image.props.onError);
  h.event(h.image.props.onError);
  h.flushTimers();
  h.event(h.image.props.onError);
  h.event(h.image.props.onError);
  assert.equal(h.tree, "placeholder");
  assert.equal(h.timerCount, 0);

  h.recover({ networkRevision: 1 });
  assert.equal(h.image.props.source, "thumbnail");
  h.event(h.image.props.onDisplay);
  const displayedKey = h.image.key;
  h.recover({ networkRevision: 2 });
  assert.equal(h.image.key, displayedKey);
  h.unmount();
});

test("a stalled card retries on reconnect once visible and ignores a late display from the previous attempt", () => {
  const h = mount({ sources: ["thumbnail"], fallback: "placeholder" });
  const oldKey = h.image.key;
  const oldDisplay = h.image.props.onDisplay;
  h.recover({ active: false });
  h.recover({ networkRevision: 1 });
  assert.equal(h.image.key, oldKey);
  h.recover({ active: true });
  assert.notEqual(h.image.key, oldKey);
  const retriedKey = h.image.key;
  h.event(oldDisplay);
  h.recover({ networkRevision: 2 });
  assert.notEqual(h.image.key, retriedKey);
  h.unmount();
});
