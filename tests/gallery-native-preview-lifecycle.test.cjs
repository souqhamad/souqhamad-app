const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const filename = path.resolve(__dirname, "../src/ui/gallery-preview-context.tsx");
const source = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "NativeGalleryPreview");
assert.ok(declaration);
const code = ts.transpileModule(`${declaration.getText(source)}\nmodule.exports = { NativeGalleryPreview };`, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function fakeCache(initial) {
  let state = initial, retries = 0;
  const listeners = new Set();
  const publish = next => { state = next; for (const listener of listeners) listener(); };
  return {
    snapshot: () => state,
    subscribe: (_url, listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    retry: () => {
      if (!["error", "stalled"].includes(state.status)) return;
      retries++; publish({ status: "loading" });
    },
    publish,
    get retries() { return retries; },
    get subscribers() { return listeners.size; },
  };
}

function mount(cache, initial = {}) {
  const hooks = [], layoutEffects = [], effects = [];
  const events = { loaded: [], errors: 0, stalled: 0 };
  let cursor = 0, dirty = false, tree;
  let props = {
    url: "display", attempt: 0, contentFit: "contain", accessibilityLabel: "Photo",
    onLoaded: size => events.loaded.push(size), onError: () => { events.errors++; }, onStalled: () => { events.stalled++; },
    ...initial,
  };
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => value === b[i]);
  const effect = queue => (fn, deps) => {
    const index = cursor++, previous = hooks[index];
    if (!previous || !same(previous.deps, deps)) queue.push(() => {
      previous?.cleanup?.(); hooks[index] = { deps, cleanup: fn() };
    });
  };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: name => { assert.equal(name, "react/jsx-runtime"); return { jsx: (type, props, key) => ({ type, props, key }) }; },
    Context: {}, useContext: () => cache, useOwnedCache: () => ({}), Image: "Image", StyleSheet: { absoluteFill: {} },
    useRef: initial => { const index = cursor++; return hooks[index] ||= { current: initial }; },
    useCallback: (fn, deps) => {
      const index = cursor++;
      if (!hooks[index] || !same(hooks[index].deps, deps)) hooks[index] = { value: fn, deps };
      return hooks[index].value;
    },
    useLayoutEffect: effect(layoutEffects), useEffect: effect(effects),
    useSyncExternalStore: (subscribe, getSnapshot) => {
      const index = cursor++, previous = hooks[index];
      if (!previous || previous.subscribe !== subscribe) {
        layoutEffects.push(() => {
          previous?.cleanup?.();
          hooks[index] = { subscribe, cleanup: subscribe(() => { dirty = true; }) };
        });
      }
      return getSnapshot();
    },
  });
  const render = () => {
    let passes = 0;
    do {
      assert.ok(++passes < 20, "The native preview must settle after its store/effect updates");
      dirty = false; cursor = 0;
      tree = module.exports.NativeGalleryPreview(props);
      while (layoutEffects.length) layoutEffects.shift()();
      while (effects.length) effects.shift()();
    } while (dirty);
  };
  render();
  return {
    events,
    image: () => tree,
    render,
    event: callback => { callback(); render(); },
    update: next => { props = { ...props, ...next }; render(); },
    unmount: () => { for (const hook of hooks) hook?.cleanup?.(); },
  };
}

function resource() { return { width: 900, height: 600, releases: 0, release() { this.releases++; } }; }

test("native cached decode is reported as visible only after its Image onDisplay", () => {
  const image = resource(), cache = fakeCache({ status: "loaded", resource: image });
  const h = mount(cache);
  assert.equal(h.events.loaded.length, 0, "Cached decoding alone must not hide a loading placeholder");
  assert.equal(h.image().props.source, image);
  h.event(() => h.image().props.onDisplay());
  assert.equal(h.events.loaded.length, 1);
  assert.equal(h.events.loaded[0], image);
  h.unmount();
});

test("retry remounts the native view without accepting old attempt display/error events", () => {
  const image = resource(), cache = fakeCache({ status: "loaded", resource: image });
  const h = mount(cache);
  const old = h.image();
  h.update({ attempt: 1 });
  assert.notEqual(h.image().key, old.key);
  assert.equal(h.image().props.source, image, "A display retry reuses the safe decoded image resource");
  h.event(() => { old.props.onDisplay(); old.props.onError(); });
  assert.equal(h.events.loaded.length, 0);
  assert.equal(h.events.errors, 0);
  h.event(() => h.image().props.onDisplay());
  assert.equal(h.events.loaded.length, 1);
  assert.equal(cache.retries, 0, "Successful cached bytes must not be downloaded again on a view retry");
  h.unmount();
});

test("an old resource display event cannot mark a replacement decoded resource visible", () => {
  const oldResource = resource(), newResource = resource();
  const cache = fakeCache({ status: "loaded", resource: oldResource }), h = mount(cache);
  const old = h.image();
  h.event(() => cache.publish({ status: "loaded", resource: newResource }));
  h.event(() => old.props.onDisplay());
  assert.equal(h.events.loaded.length, 0);
  h.event(() => h.image().props.onDisplay());
  assert.equal(h.events.loaded[0], newResource);
  h.unmount();
});

test("opening an active cached failed photo starts one recovery while detail keeps a subscription", () => {
  const cache = fakeCache({ status: "error" });
  const stopDetail = cache.subscribe("display", () => {}, 0);
  const h = mount(cache, { priority: 20 });
  assert.equal(cache.subscribers, 2);
  assert.equal(cache.retries, 1);
  h.render(); h.update({ accessibilityLabel: "Updated caption" });
  assert.equal(cache.retries, 1, "Ordinary re-renders must not restart active loads indefinitely");
  const image = resource();
  h.event(() => cache.publish({ status: "loaded", resource: image }));
  assert.equal(h.events.loaded.length, 0);
  h.event(() => h.image().props.onDisplay());
  assert.equal(h.events.loaded.length, 1);
  h.unmount();
  assert.equal(cache.subscribers, 1);
  assert.equal(image.releases, 0, "A gallery view must not release the resource owned by its listing cache");
  stopDetail();
});

test("selecting an already mounted stalled preview retries it once and keeps the shared success", () => {
  const cache = fakeCache({ status: "stalled" }), h = mount(cache);
  assert.equal(h.events.stalled, 1);
  h.update({ priority: 20 });
  assert.equal(cache.retries, 1);
  const image = resource();
  h.event(() => cache.publish({ status: "loaded", resource: image }));
  const key = h.image().key;
  h.update({ priority: 0 });
  assert.equal(h.image().key, key);
  assert.equal(h.image().props.source, image);
  h.unmount();
  assert.equal(image.releases, 0);
  assert.equal(cache.subscribers, 0);
});
