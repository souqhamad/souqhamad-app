const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

// Run the actual image component and hooks with controlled native events and
// time. This verifies retry/render behavior rather than a copied state machine.
const filename = path.resolve(__dirname, "../src/ui/zoomable-gallery-image.tsx");
const source = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(["useImageLayer", "ProgressiveListingImage", "ProgressiveListingImageContent"]);
const functions = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
assert.equal(functions.length, 3);
const code = ts.transpileModule(`const IMAGE_WAIT_MS = 15000;\n${functions.map(node => node.getText(source)).join("\n")}\nmodule.exports = { ProgressiveListingImageContent, ProgressiveListingImage };`, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function mount(props, platform = "web") {
  const hooks = [], pending = [], timers = new Map();
  let cursor = 0, dirty = false, tree, now = 0, timerId = 0, writes = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => value === b[i]);
  const effect = (fn, deps) => {
    const index = cursor++;
    const previous = hooks[index];
    if (!previous || !same(previous.deps, deps)) pending.push(() => {
      previous?.cleanup?.();
      hooks[index] = { deps, cleanup: fn() };
    });
  };
  const jsx = (type, props, key) => ({ type, props: props || {}, key });
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: name => {
      assert.equal(name, "react/jsx-runtime");
      return { jsx, jsxs: jsx, Fragment: "Fragment" };
    },
    useState: initial => {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { value: typeof initial === "function" ? initial() : initial };
      return [hooks[index].value, value => {
        writes++;
        const next = typeof value === "function" ? value(hooks[index].value) : value;
        if (next !== hooks[index].value) { hooks[index].value = next; dirty = true; }
      }];
    },
    useRef: initial => { const index = cursor++; return hooks[index] ||= { current: initial }; },
    useCallback: (fn, deps) => {
      const index = cursor++;
      if (!hooks[index] || !same(hooks[index].deps, deps)) hooks[index] = { value: fn, deps };
      return hooks[index].value;
    },
    useEffect: effect, useLayoutEffect: effect,
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, due: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    Platform: { OS: platform },
    useTheme: () => ({ colors: { primary: "green", muted: "gray" } }),
    useStyles: () => ({}), StyleSheet: { absoluteFill: {} },
    Image: "Image", NativeGalleryPreview: "NativePreview", View: "View",
    ActivityIndicator: "Spinner", Icon: "Icon", AppText: "Text", InlineNotice: "Notice",
  });
  const render = () => {
    let passes = 0;
    do {
      assert.ok(++passes < 30, "The component must settle without an effect loop");
      dirty = false; cursor = 0;
      tree = module.exports.ProgressiveListingImageContent({ accessibilityLabel: "fixture", ...props });
      while (pending.length) pending.shift()();
    } while (dirty);
  };
  const nodes = (type, node = tree) => {
    if (!node) return [];
    if (Array.isArray(node)) return node.flatMap(child => nodes(type, child ?? null));
    if (typeof node !== "object") return [];
    return [...(node.type === type ? [node] : []), ...nodes(type, node.props?.children ?? null)];
  };
  render();
  return {
    nodes, wrapper: module.exports.ProgressiveListingImage,
    event: fn => { fn(); render(); },
    update: next => { props = { ...props, ...next }; render(); },
    tick: ms => {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.fn(); }
      render();
    },
    unmount: () => { hooks.forEach(hook => hook?.cleanup?.()); },
    get writes() { return writes; }, get timerCount() { return timers.size; },
  };
}
const size = { width: 900, height: 600 };
const image = (harness, url) => harness.nodes("Image").find(node => node.props.source === url);
const loaded = (harness, url) => harness.event(() => {
  const node = image(harness, url);
  node.props.onLoad({ source: size });
  node.props.onDisplay();
});

test("retry of a failed original preserves the displayed preview and its native view key", () => {
  const h = mount({ source: "original", previewSource: "display", thumbnailSource: "thumb", loadOriginal: true });
  assert.equal(h.nodes("Image").length, 3);
  loaded(h, "display");
  const previewKey = image(h, "display").key;
  h.event(() => image(h, "original").props.onError());
  h.event(() => h.nodes("Notice")[0].props.onRetry());
  assert.equal(image(h, "display").key, previewKey);
  assert.equal(h.nodes("Spinner").length, 1, "Only the small original-loading badge remains");
  loaded(h, "original");
  assert.equal(h.nodes("Spinner").length, 0);
  h.unmount();
});

test("successful thumbnail remains visible when retrying the failed display", () => {
  const h = mount({ source: "original", previewSource: "display", thumbnailSource: "thumb", loadOriginal: true });
  h.event(() => image(h, "display").props.onError());
  loaded(h, "thumb");
  const thumbnailKey = image(h, "thumb").key;
  h.event(() => image(h, "original").props.onError());
  h.event(() => h.nodes("Notice")[0].props.onRetry());
  assert.equal(image(h, "thumb").key, thumbnailKey);
  loaded(h, "display");
  assert.ok(image(h, "display"));
  h.unmount();
});

test("stalled original remains mounted and accepts its late native success", () => {
  const h = mount({ source: "original", previewSource: "display", loadOriginal: true });
  loaded(h, "display");
  const oldKey = image(h, "original").key;
  h.tick(15000);
  assert.equal(h.nodes("Notice").length, 1);
  assert.ok(image(h, "display"));
  assert.equal(image(h, "original").key, oldKey);
  loaded(h, "original");
  assert.equal(h.nodes("Notice").length, 0);
  assert.equal(h.nodes("Spinner").length, 0);
  h.unmount();
});

test("explicit retry ignores callbacks from the superseded attempt", () => {
  const h = mount({ source: "original", previewSource: "display", loadOriginal: true });
  loaded(h, "display");
  const oldLoad = image(h, "original").props.onLoad;
  h.tick(15000);
  h.event(() => h.nodes("Notice")[0].props.onRetry());
  h.event(() => oldLoad({ source: size }));
  assert.equal(h.nodes("Spinner").length, 1);
  loaded(h, "original");
  assert.equal(h.nodes("Spinner").length, 0);
  h.unmount();
});

test("cached thumbnail is available while preview and original are still pending", () => {
  const h = mount({ source: "original", previewSource: "display", thumbnailSource: "thumb", loadOriginal: true });
  assert.ok(image(h, "thumb"));
  loaded(h, "thumb");
  assert.equal(h.nodes("Icon").length, 0);
  assert.ok(image(h, "display"));
  loaded(h, "display");
  assert.ok(image(h, "thumb"));
  h.unmount();
});

test("transient original errors retry twice while preserving the displayed preview", () => {
  const h = mount({ source: "original", previewSource: "display", loadOriginal: true });
  loaded(h, "display");
  const key = image(h, "display").key;
  for (const delay of [600, 1200]) {
    h.event(() => image(h, "original").props.onError());
    h.tick(delay);
    assert.ok(image(h, "original"));
    assert.equal(image(h, "display").key, key);
  }
  h.event(() => image(h, "original").props.onError());
  h.tick(60000);
  assert.ok(image(h, "original"), "Keep the native view subscribed to late recovery after bounded retries");
  assert.equal(h.nodes("Notice").length, 1);
  assert.ok(image(h, "display"));
  h.unmount();
});

test("native original stalls retry twice automatically while keeping the preview visible", () => {
  const h = mount({ source: "original", previewSource: "display", loadOriginal: true }, "android");
  const preview = h.nodes("NativePreview").find(node => node.props.url === "display");
  h.event(() => preview.props.onLoaded(size));
  const previewKey = preview.key;
  let originalKey = image(h, "original").key;

  h.tick(15000);
  assert.equal(h.nodes("Notice").length, 1);
  h.tick(600);
  assert.notEqual(image(h, "original").key, originalKey);
  assert.equal(h.nodes("NativePreview").find(node => node.props.url === "display").key, previewKey);
  originalKey = image(h, "original").key;

  h.tick(15000);
  h.tick(1200);
  assert.notEqual(image(h, "original").key, originalKey);
  originalKey = image(h, "original").key;

  h.tick(15000);
  h.tick(5000);
  assert.equal(image(h, "original").key, originalKey, "Retries stay bounded after two recoveries");
  assert.ok(h.nodes("NativePreview").find(node => node.props.url === "display"), "The decoded preview remains visible while the original is unavailable");
  h.unmount();
});

test("delayed preview does not show an error merely because original failed first", () => {
  const h = mount({ source: "original", previewSource: "display", loadOriginal: true });
  h.event(() => image(h, "original").props.onError());
  assert.equal(h.nodes("Notice").length, 0);
  loaded(h, "display");
  assert.equal(h.nodes("Notice").length, 1);
  h.unmount();
});

test("same-URL aliases and original-only sources each request one image", () => {
  for (const props of [
    { source: "same", previewSource: "same", thumbnailSource: "same" },
    { source: "same" },
  ]) {
    const h = mount({ ...props, loadOriginal: true });
    assert.equal(h.nodes("Image").length, 1);
    loaded(h, "same");
    assert.equal(h.nodes("Spinner").length, 0);
    h.unmount();
  }
});

test("native alias records share one decoded image instead of loading the same URL twice", () => {
  const h = mount({ source: "same", previewSource: "same", thumbnailSource: "same", loadOriginal: true }, "android");
  assert.equal(h.nodes("NativePreview").length, 1);
  assert.equal(h.nodes("Image").length, 0);
  h.event(() => h.nodes("NativePreview")[0].props.onLoaded(size));
  assert.equal(h.nodes("Spinner").length, 0);
  h.unmount();
});

test("a loaded legacy source stays mounted when swiping away while its preview is pending", () => {
  const h = mount({ source: "original", previewSource: "display", loadOriginal: true, active: true }, "android");
  loaded(h, "original");
  const key = image(h, "original").key;
  h.update({ loadOriginal: false, active: false });
  assert.equal(image(h, "original").key, key);
  assert.equal(h.nodes("Spinner").length, 0);
  h.update({ loadOriginal: true, active: true });
  assert.equal(image(h, "original").key, key);
  assert.equal(h.nodes("Spinner").length, 0);
  h.unmount();
});

test("returning to an exhausted source starts a fresh bounded attempt", () => {
  const h = mount({ source: "original", previewSource: "display", loadOriginal: true, active: true }, "android");
  for (const delay of [600, 1200]) {
    h.event(() => image(h, "original").props.onError());
    h.tick(delay);
  }
  h.event(() => image(h, "original").props.onError());
  const failedKey = image(h, "original").key;
  h.update({ loadOriginal: false, active: false });
  h.update({ loadOriginal: true, active: true });
  assert.notEqual(image(h, "original").key, failedKey);
  loaded(h, "original");
  assert.equal(h.nodes("Spinner").length, 0);
  assert.equal(h.nodes("Notice").length, 0);
  h.unmount();
});

test("native previews remain subscribed after error and accept a shared-cache recovery", () => {
  const h = mount({ source: "display", previewSource: "display", active: true }, "android");
  const preview = h.nodes("NativePreview")[0];
  h.event(() => preview.props.onError());
  assert.equal(h.nodes("NativePreview").length, 1);
  assert.equal(h.nodes("Notice").length, 1);
  h.event(() => h.nodes("NativePreview")[0].props.onLoaded(size));
  assert.equal(h.nodes("Spinner").length, 0);
  assert.equal(h.nodes("Notice").length, 0);
  h.unmount();
});

test("native cache owns preview deadlines rather than a timer started by a queued view", () => {
  const h = mount({ source: "display", previewSource: "display" }, "android");
  h.tick(60000);
  assert.equal(h.nodes("Notice").length, 0);
  assert.equal(h.nodes("NativePreview").length, 1);
  h.event(() => h.nodes("NativePreview")[0].props.onStalled());
  assert.equal(h.nodes("Notice").length, 1);
  h.event(() => h.nodes("NativePreview")[0].props.onLoaded(size));
  assert.equal(h.nodes("Spinner").length, 0);
  h.unmount();
});

test("full sources become ready only after the native view confirms display", () => {
  const h = mount({ source: "original", previewSource: "display", loadOriginal: true }, "android");
  h.event(() => image(h, "original").props.onLoad({ source: size }));
  assert.equal(h.nodes("Spinner").length, 1);
  h.event(() => image(h, "original").props.onDisplay());
  assert.equal(h.nodes("Spinner").length, 0);
  h.unmount();
});

test("native display and load events may arrive in either order", () => {
  const h = mount({ source: "original", previewSource: "display", loadOriginal: true }, "android");
  h.event(() => image(h, "original").props.onDisplay());
  assert.equal(h.nodes("Spinner").length, 1);
  h.event(() => image(h, "original").props.onLoad({ source: size }));
  assert.equal(h.nodes("Spinner").length, 0);
  h.unmount();
});

test("a superseded native display event cannot mark a retry ready", () => {
  const h = mount({ source: "original", previewSource: "display", loadOriginal: true }, "android");
  const oldDisplay = image(h, "original").props.onDisplay;
  h.event(() => image(h, "original").props.onError());
  h.tick(600);
  h.event(() => image(h, "original").props.onLoad({ source: size }));
  h.event(oldDisplay);
  assert.equal(h.nodes("Spinner").length, 1);
  h.event(() => image(h, "original").props.onDisplay());
  assert.equal(h.nodes("Spinner").length, 0);
  h.unmount();
});

test("a displayed native alias survives page activation changes without a new attempt", () => {
  const h = mount({ source: "same", previewSource: "same", loadOriginal: true, active: true }, "android");
  const before = h.nodes("NativePreview")[0];
  h.event(() => before.props.onLoaded(size));
  h.update({ loadOriginal: false, active: false });
  assert.equal(h.nodes("Spinner").length, 0);
  h.update({ loadOriginal: true, active: true });
  const after = h.nodes("NativePreview")[0];
  assert.equal(after.key, before.key);
  assert.equal(after.props.attempt, before.props.attempt);
  assert.equal(h.nodes("Spinner").length, 0);
  h.unmount();
});

test("returning to a failed native preview requests cache recovery without removing its view", () => {
  const h = mount({ source: "same", previewSource: "same", loadOriginal: true, active: true }, "android");
  const before = h.nodes("NativePreview")[0];
  h.event(() => before.props.onError());
  h.update({ loadOriginal: false, active: false });
  h.update({ loadOriginal: true, active: true });
  const after = h.nodes("NativePreview")[0];
  assert.equal(after.key, before.key);
  assert.equal(after.props.attempt, before.props.attempt + 1);
  h.event(() => after.props.onLoaded(size));
  assert.equal(h.nodes("Spinner").length, 0);
  h.unmount();
});

test("a fresh native error after successful display is not hidden by old loaded state", () => {
  const h = mount({ source: "original", previewSource: "display", loadOriginal: true }, "android");
  loaded(h, "original");
  const key = image(h, "original").key;
  h.event(() => image(h, "original").props.onError());
  h.tick(600);
  assert.notEqual(image(h, "original").key, key);
  loaded(h, "original");
  assert.equal(h.nodes("Spinner").length, 0);
  h.unmount();
});

test("closing a loading image clears timers and ignores callbacks from its removed native view", () => {
  const h = mount({ source: "original", previewSource: "display", loadOriginal: true });
  const oldLoad = image(h, "display").props.onLoad;
  h.unmount();
  const writes = h.writes;
  oldLoad({ source: size });
  assert.equal(h.writes, writes);
  assert.equal(h.timerCount, 0);
  assert.notEqual(h.wrapper({ source: "first" }).key, h.wrapper({ source: "second" }).key,
    "Source changes replace the resource lifecycle rather than retaining old status");
});

test("a stalled shared display offers retry while the loaded thumbnail stays visible", () => {
  const h = mount({ source: "display", previewSource: "display", thumbnailSource: "thumb", loadOriginal: true, active: true }, "android");
  const preview = url => h.nodes("NativePreview").find(node => node.props.url === url);
  h.event(() => preview("thumb").props.onLoaded(size));
  h.event(() => preview("display").props.onStalled());
  assert.equal(h.nodes("Notice").length, 1);
  assert.equal(h.nodes("NativePreview").length, 2);
  h.event(() => preview("display").props.onLoaded(size));
  assert.equal(h.nodes("Notice").length, 0);
  h.unmount();
});
