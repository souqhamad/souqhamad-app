const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

function load(relative, imports, globals = {}) {
  const filename = path.resolve(__dirname, "..", relative);
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports,
    require: name => { assert.ok(Object.hasOwn(imports, name), name); return imports[name]; }, ...globals,
  });
  return module.exports;
}
function harness(platform = "android") {
  const hooks = [], effects = [], listeners = new Map(), frames = new Map(), scrolls = [];
  let focused, cursor = 0, frameId = 0, offset = 0;
  let viewport = { x: 0, y: 100, width: 390, height: 744 }, delayed;
  const geometry = load("src/ui/form-keyboard-geometry.ts", {});
  const code = load("src/ui/form-keyboard-scroll-view.tsx", {
    react: {
      useRef: initial => hooks[cursor++] = { current: initial },
      useCallback: fn => fn,
      useEffect: effect => effects.push(effect),
    },
    "react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    "react-native": {
      Platform: { OS: platform }, View: "View", ScrollView: "ScrollView", StyleSheet: { create: value => value },
      Keyboard: { metrics: () => null, addListener: (event, handler) => {
        listeners.set(event, handler); return { remove: () => listeners.delete(event) };
      } },
      TextInput: { State: { currentlyFocusedInput: () => {
        assert.notEqual(platform, "web", "native focus state must not be read on web"); return focused;
      } } },
    },
    "./chat-keyboard-layout": { ChatKeyboardLayout: "KeyboardLayout" },
    "./form-keyboard-geometry": geometry,
  }, {
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: id => frames.delete(id),
  });
  const tree = code.FormKeyboardScrollView({ children: "Form", contentContainerStyle: { padding: 12 } });
  const frame = tree.props.children, scroll = frame.props.children;
  frame.props.ref.current = { measureInWindow: callback => {
    if (delayed) delayed.push(() => callback(...Object.values(viewport)));
    else callback(...Object.values(viewport));
  } };
  scroll.props.ref.current = { scrollTo: value => {
    scrolls.push(value);
    if (focused) focused.rect.y -= value.y - offset;
    offset = value.y;
    scroll.props.onScroll({ nativeEvent: { contentOffset: { y: offset } } });
  } };
  const cleanups = effects.map(effect => effect());
  const input = rect => ({ rect: { x: 12, y: 690, width: 366, height: 45, ...rect },
    owned: true,
    measureLayout(_ancestor, success, failure) { if (this.owned) success(0, 0, this.rect.width, this.rect.height); else failure(); },
    measureInWindow(callback) { callback(...Object.values(this.rect)); } });
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); };
  return { tree, frame, scroll, scrolls, listeners, input, flush,
    focus: (value, captureFirst = false) => {
      if (captureFirst) { scroll.props.onFocusCapture(); focused = value; }
      else { focused = value; scroll.props.onFocusCapture(); }
    },
    blur: () => { focused = undefined; scroll.props.onBlurCapture(); },
    show: () => listeners.get("keyboardDidShow")?.({ endCoordinates: { screenX: 0, screenY: 500, width: 390, height: 344 } }),
    hide: () => listeners.get("keyboardDidHide")?.({}),
    resize: height => { viewport = { ...viewport, height }; frame.props.onLayout(); },
    delayMeasurements: () => { delayed = []; return delayed; },
    unmount: () => cleanups.forEach(cleanup => cleanup?.()),
  };
}

for (const platform of ["android", "ios"]) test(`${platform}: focus before keyboard resize is revealed above the IME and not lifted twice`, () => {
  const h = harness(platform), input = h.input();
  h.focus(input); h.flush();
  assert.equal(h.scrolls.length, 0);
  h.show(); h.resize(400); h.flush();
  assert.equal(h.scrolls.length, 1);
  assert.equal(h.scrolls[0].y, 247);
  assert.ok(input.rect.y + input.rect.height <= 488);
  h.resize(400); h.flush();
  assert.equal(h.scrolls.length, 1);
  assert.equal(h.scroll.props.automaticallyAdjustKeyboardInsets, false);
  assert.equal(h.scroll.props.keyboardShouldPersistTaps, "handled");
  h.unmount();
  assert.equal(h.listeners.size, 0);
});

test("late measurement of a blurred field cannot scroll a newly focused field", () => {
  const h = harness(), old = h.input(), next = h.input({ y: 300 });
  const pending = h.delayMeasurements();
  h.focus(old); h.show(); h.flush();
  h.blur(); h.focus(next); h.flush();
  pending[0](); pending[1]();
  assert.equal(h.scrolls.length, 0);
  h.unmount();
});

test("manual dragging and unmount cancel scheduled keyboard corrections", () => {
  const h = harness();
  h.focus(h.input()); h.show(); h.scroll.props.onScrollBeginDrag(); h.flush();
  assert.equal(h.scrolls.length, 0);
  h.focus(h.input()); h.show(); h.unmount(); h.flush();
  assert.equal(h.scrolls.length, 0);
});

test("web uses the browser viewport and never subscribes to native keyboard events", () => {
  const h = harness("web");
  h.focus(undefined); h.resize(400); h.flush();
  assert.equal(h.listeners.size, 0);
  assert.equal(h.scrolls.length, 0);
  h.unmount();
});


test("focus capture waits for the TextInput target to update native focus state", () => {
  const h = harness(), input = h.input();
  h.show();
  h.focus(input, true);
  h.flush();
  assert.equal(h.scrolls.length, 1);
  assert.equal(h.scrolls[0].y, 247);
  h.unmount();
});


test("a selection modal's focused input cannot move the form behind its separate native window", () => {
  const h = harness(), input = h.input();
  input.owned = false;
  h.focus(input); h.show(); h.resize(400); h.flush();
  assert.equal(h.scrolls.length, 0);
  h.unmount();
});

test("keyboard dismissal and interactive frame events preserve intentional manual scrolling", () => {
  const h = harness("ios"), input = h.input();
  h.focus(input); h.show(); h.resize(400); h.flush();
  const count = h.scrolls.length;
  h.scroll.props.onScrollBeginDrag();
  input.rect.y = 1000;
  h.hide(); h.resize(744);
  h.listeners.get("keyboardWillChangeFrame")({ endCoordinates: { screenX: 0, screenY: 600, width: 390, height: 244 } });
  h.flush();
  assert.equal(h.scrolls.length, count);
  h.show(); h.flush();
  assert.equal(h.scrolls.length, count + 1, "a new keyboard show can reveal the focused field again");
  h.unmount();
});

test("a changed scroll offset invalidates an in-flight measurement instead of adding the offset twice", () => {
  const h = harness(), input = h.input();
  const pending = h.delayMeasurements();
  h.focus(input); h.show(); h.flush();
  h.scroll.props.onScroll({ nativeEvent: { contentOffset: { y: 100 } } });
  input.rect.y = 590;
  pending[0]();
  assert.equal(h.scrolls.length, 0);
  h.resize(400); h.flush(); pending[1]();
  assert.equal(h.scrolls[0].y, 247);
  h.unmount();
});
