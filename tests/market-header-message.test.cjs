const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const compile = relative => {
  const filename = path.resolve(__dirname, relative);
  return ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
};
const componentCode = compile("../src/features/marketplace/market-header-message.tsx");
const visibilityCode = compile("../src/core/visible-query.ts");
const nodes = (node, type) => !node || typeof node !== "object" ? [] : Array.isArray(node)
  ? node.flatMap(child => nodes(child, type))
  : [...(node.type === type ? [node] : []), ...nodes(node.props?.children, type)];
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

// Run the real keyed component and visibility hook; native hosts, measurements,
// animation scheduling and accessibility events are the controlled boundaries.
function mount(options = {}) {
  let hooks = [], pending = [], cursor = 0, dirty = false, tree = null, mountedKey;
  let props = { message: { message: "رسالة التطبيق", type: "info" }, ...options.props };
  let focused = true, stateWrites = 0, removedMotion = 0, removedAppState = 0;
  let resolveMotion;
  let now = 1_800_000_000_000, timerId = 0;
  const timers = new Map();
  const probe = new Promise(resolve => { resolveMotion = resolve; });
  const motionListeners = new Set(), appListeners = new Set();
  const timings = [], loops = [], values = [], scrolls = [];
  const scrollHost = { scrollTo: value => scrolls.push({ method: "scrollTo", ...value }), scrollToEnd: value => scrolls.push({ method: "scrollToEnd", ...value }) };
  const cleanup = () => hooks.forEach(hook => hook?.cleanup?.());
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { value: typeof initial === "function" ? initial() : initial };
      const hook = hooks[index];
      return [hook.value, update => {
        stateWrites++;
        const next = typeof update === "function" ? update(hook.value) : update;
        if (!Object.is(next, hook.value)) { hook.value = next; dirty = true; }
      }];
    },
    useRef(initial) { const index = cursor++; return hooks[index] ||= { current: initial }; },
    useEffect(effect, deps) {
      const index = cursor++, previous = hooks[index];
      if (!previous || deps.length !== previous.deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        pending.push(() => { previous?.cleanup?.(); hooks[index] = { deps, cleanup: effect() }; });
      }
    },
    useSyncExternalStore(subscribe, snapshot) {
      react.useEffect(() => subscribe(() => { dirty = true; }), [subscribe]);
      return snapshot();
    },
  };
  const AppState = {
    currentState: "active",
    addEventListener(name, callback) {
      assert.equal(name, "change"); appListeners.add(callback);
      return { remove() { removedAppState++; appListeners.delete(callback); } };
    },
  };
  class Value {
    constructor(initial) { this.value = initial; this.resets = []; values.push(this); }
    setValue(value) { this.value = value; this.resets.push(value); }
    interpolate(config) { return { value: this, ...config }; }
  }
  const Easing = { linear: value => value };
  const native = {
    AppState, View: "View", ScrollView: "ScrollView", Easing,
    Platform: { OS: options.platform ?? "android" }, StyleSheet: { create: value => value },
    AccessibilityInfo: {
      isReduceMotionEnabled: () => probe,
      addEventListener(name, callback) {
        assert.equal(name, "reduceMotionChanged"); motionListeners.add(callback);
        return { remove() { removedMotion++; motionListeners.delete(callback); } };
      },
    },
    Animated: {
      Value, View: "Animated.View",
      timing(value, config) { const animation = { value, config }; timings.push(animation); return animation; },
      loop(animation) {
        const loop = { animation, starts: 0, stops: 0, running: false,
          start() { this.starts++; this.running = true; }, stop() { this.stops++; this.running = false; } };
        loops.push(loop); return loop;
      },
    },
  };
  const jsx = (type, elementProps, key) => ({ type, props: elementProps ?? {}, key });
  const colors = { primarySoft: "soft", primary: "primary", warning: "warning", success: "success" };
  const imports = {
    react, "react/jsx-runtime": { jsx, jsxs: jsx }, "react-native": native,
    "expo-router": { useIsFocused: () => focused }, "@tanstack/react-query": {}, "./visible-query-read": {},
    "../../ui": { AppText: "AppText" },
    "../../ui/theme-context": { useTheme: () => ({ colors }), createThemedStyles: create => { const styles = create(colors); return () => styles; } },
  };
  const load = code => {
    const module = { exports: {} };
    vm.runInNewContext(code, {
      module, exports: module.exports,
      Date: class extends Date { static now() { return now; } },
      setTimeout(callback, delay) { timers.set(++timerId, { callback, at: now + delay }); return timerId; },
      clearTimeout(id) { timers.delete(id); },
      require: name => {
        assert.ok(Object.hasOwn(imports, name), `Unexpected header dependency ${name}`); return imports[name];
      },
    });
    return module.exports;
  };
  imports["../../core/visible-query"] = load(visibilityCode);
  const { MarketHeaderMessage } = load(componentCode);
  function render() {
    let passes = 0;
    do {
      assert.ok(++passes < 15, "Header measurements and effects must settle");
      dirty = false;
      const wrapper = MarketHeaderMessage(props);
      if (wrapper?.key !== mountedKey) {
        cleanup(); hooks = []; pending = []; mountedKey = wrapper?.key;
      }
      cursor = 0;
      tree = wrapper ? wrapper.type(wrapper.props) : null;
      for (const scroll of nodes(tree, "ScrollView")) scroll.props.ref.current = scrollHost;
      while (pending.length) pending.shift()();
    } while (dirty);
    return tree;
  }
  const event = callback => { callback(); return render(); };
  render();
  return {
    render, timings, loops, values, scrolls, Easing,
    get tree() { return tree; },
    get stateWrites() { return stateWrites; },
    get timerCount() { return timers.size; },
    get subscriptions() { return { motion: motionListeners.size, app: appListeners.size, removedMotion, removedAppState }; },
    async ready(value = false) { resolveMotion(value); await tick(); render(); },
    async resolveAfterUnmount(value) { resolveMotion(value); await tick(); },
    measure(viewport, textWidth) {
      return event(() => {
        nodes(tree, "View").find(node => node.props.onLayout).props.onLayout({ nativeEvent: { layout: { width: viewport } } });
        nodes(tree, "AppText")[0].props.onLayout({ nativeEvent: { layout: { width: textWidth } } });
      });
    },
    viewport(width) { return event(() => nodes(tree, "View").find(node => node.props.onLayout).props.onLayout({ nativeEvent: { layout: { width } } })); },
    reduceMotion(value) { return event(() => { for (const listener of motionListeners) listener(value); }); },
    focus(value) { return event(() => { focused = value; }); },
    foreground(value) { return event(() => { AppState.currentState = value ? "active" : "background"; for (const listener of appListeners) listener(); }); },
    update(message) { return event(() => { props = { message }; }); },
    advance(milliseconds) {
      return event(() => {
        now += milliseconds;
        for (const [id, timer] of [...timers]) {
          if (timer.at > now) continue;
          timers.delete(id);
          timer.callback();
        }
      });
    },
    unmount() { cleanup(); hooks = []; pending = []; mountedKey = undefined; tree = null; },
  };
}

test("absent and blank messages have no header host or subscriptions", () => {
  for (const message of [undefined, null, { message: " \n\t ", type: "info" }]) {
    const h = mount({ props: { message } });
    assert.equal(h.tree, null);
    assert.equal(h.loops.length, 0);
    assert.equal(h.subscriptions.motion, 0);
    assert.equal(h.subscriptions.app, 0);
    h.unmount();
  }
});

test("short text remains one static, accessible copy after measurement", async () => {
  const h = mount({ props: { message: { message: "  خبر\n جديد  ", type: "warning" } } });
  await h.ready(); h.measure(200, 80);
  assert.equal(h.loops.length, 0);
  assert.equal(nodes(h.tree, "AppText").length, 1);
  assert.equal(nodes(h.tree, "View")[0].props.accessibilityLabel, "خبر جديد");
  assert.equal(nodes(h.tree, "AppText")[0].props.children, "خبر جديد");
  assert.equal(nodes(h.tree, "AppText")[0].props.style[1].color, "warning");
  assert.equal(nodes(h.tree, "Animated.View")[0].props.style[1].transform[0].translateX, 0);
  assert.equal(nodes(h.tree, "ScrollView")[0].props.scrollEnabled, false);
  h.unmount();
});

test("an app message expires on the open screen and when resuming after expiry", async () => {
  const message = { message: "رسالة مؤقتة", type: "info", expiresAt: new Date(1_800_000_001_000).toISOString() };
  const h = mount({ props: { message } });
  await h.ready(); h.measure(100, 300);
  assert.equal(h.timerCount, 1);
  h.advance(999);
  assert.ok(h.tree);
  h.advance(1);
  assert.equal(h.tree, null);
  assert.equal(h.loops[0].stops, 1);
  assert.equal(h.timerCount, 0);

  h.update({ ...message, expiresAt: new Date(1_800_000_002_000).toISOString() });
  assert.ok(h.tree, "A new expiry can show the same message again");
  h.foreground(false);
  assert.equal(h.timerCount, 0);
  h.advance(1000);
  h.foreground(true);
  assert.equal(h.tree, null);
  h.unmount();
});

test("long text loops toward positive X with matching copies and constant nonblocking speed", async () => {
  for (const platform of ["android", "ios", "web"]) {
    const h = mount({ platform });
    await h.ready();
    assert.equal(h.loops.length, 0, "No animation starts before both widths are known");
    h.measure(120, 300);
    const loop = h.loops[0], timing = h.timings[0];
    assert.equal(loop.starts, 1); assert.equal(loop.running, true);
    assert.equal(timing.config.toValue, 1);
    assert.equal(timing.config.easing, h.Easing.linear);
    assert.equal(timing.config.isInteraction, false);
    assert.equal(timing.config.useNativeDriver, platform !== "web");
    const track = nodes(h.tree, "Animated.View")[0];
    const range = track.props.style[1].transform[0].translateX;
    const period = 300 + track.props.style[0].gap;
    assert.deepEqual(Array.from(range.inputRange), [0, 1]);
    assert.equal(range.outputRange[1] - range.outputRange[0], period);
    assert.ok(range.outputRange[1] > range.outputRange[0]);
    assert.equal(range.outputRange[0] + period, range.outputRange[1], "At the reset, the second copy takes the first copy's exact position");
    assert.equal(timing.config.duration, Math.round(period / 24 * 1000));
    assert.equal(track.props.style[0].direction, "ltr");
    const copies = nodes(h.tree, "AppText");
    assert.equal(copies.length, 2); assert.equal(copies[0].props.children, copies[1].props.children);
    assert.equal(copies[1].props.accessible, false);
    assert.equal(nodes(h.tree, "ScrollView")[0].props.accessibilityElementsHidden, true);
    h.measure(120, 500);
    assert.equal(loop.stops, 1);
    assert.equal(h.timings[1].config.duration, Math.round((500 + track.props.style[0].gap) / 24 * 1000));
    assert.equal(h.values.length, 1, "Width changes retain the stable Animated.Value");
    h.unmount(); assert.equal(h.loops[1].stops, 1);
  }
});

test("resizing to fit stops the loop and restores a single static copy", async () => {
  const h = mount(); await h.ready(); h.measure(100, 300);
  const loop = h.loops[0];
  h.viewport(400);
  assert.equal(loop.stops, 1); assert.equal(loop.running, false);
  assert.equal(nodes(h.tree, "AppText").length, 1);
  assert.equal(nodes(h.tree, "Animated.View")[0].props.style[1].transform[0].translateX, 0);
  assert.equal(h.values[0].resets.at(-1), 0);
  assert.deepEqual(h.scrolls.at(-1), { method: "scrollTo", x: 0, animated: false });
  h.unmount();
});

test("reduced motion replaces automatic travel with manual access to the full text", async () => {
  const h = mount(); await h.ready(); h.measure(100, 350);
  const loop = h.loops[0]; h.reduceMotion(true);
  assert.equal(loop.stops, 1); assert.equal(h.loops.length, 1);
  assert.equal(nodes(h.tree, "AppText").length, 1);
  assert.equal(nodes(h.tree, "AppText")[0].props.children, "رسالة التطبيق");
  const scroll = nodes(h.tree, "ScrollView")[0];
  assert.equal(scroll.props.scrollEnabled, true);
  assert.equal(scroll.props.horizontal, true);
  assert.deepEqual(h.scrolls.at(-1), { method: "scrollToEnd", animated: false });
  scroll.props.onContentSizeChange();
  assert.deepEqual(h.scrolls.at(-1), { method: "scrollToEnd", animated: false });
  h.reduceMotion(false);
  assert.equal(h.loops.length, 2); assert.equal(h.loops[1].running, true);
  h.unmount();
  const initiallyReduced = mount();
  await initiallyReduced.ready(true); initiallyReduced.measure(100, 350);
  assert.equal(initiallyReduced.loops.length, 0);
  assert.equal(nodes(initiallyReduced.tree, "ScrollView")[0].props.scrollEnabled, true);
  initiallyReduced.unmount();
});

test("focus, background and unmount stop animation and remove native listeners", async () => {
  const h = mount(); await h.ready(); h.measure(100, 350);
  h.focus(false);
  assert.equal(h.loops[0].stops, 1);
  h.render(); assert.equal(h.loops.length, 1);
  h.focus(true); assert.equal(h.loops[1].running, true);
  h.foreground(false); assert.equal(h.loops[1].stops, 1);
  h.render(); assert.equal(h.loops.length, 2);
  h.foreground(true); assert.equal(h.loops[2].running, true);
  assert.equal(h.subscriptions.motion, 1); assert.equal(h.subscriptions.app, 1);
  h.unmount();
  assert.equal(h.loops[2].stops, 1);
  assert.deepEqual(h.subscriptions, { motion: 0, app: 0, removedMotion: 1, removedAppState: 1 });
});

test("message changes reset measurements and motion while late accessibility reads cannot update an unmounted header", async () => {
  const h = mount(); await h.ready(); h.measure(100, 350);
  h.update({ message: "رسالة بديلة", type: "success" });
  assert.equal(h.loops[0].stops, 1);
  assert.equal(h.loops.length, 1, "The replacement must be measured before it animates");
  assert.equal(h.values.length, 2);
  assert.equal(h.values[1].resets.at(-1), 0);
  assert.equal(nodes(h.tree, "AppText").length, 1);
  assert.equal(nodes(h.tree, "View")[0].props.accessibilityLabel, "رسالة بديلة");
  await tick(); h.render(); h.measure(100, 350);
  assert.equal(h.loops.length, 2);
  h.update(null); assert.equal(h.tree, null); assert.equal(h.loops[1].stops, 1);
  assert.equal(h.subscriptions.motion, 0); assert.equal(h.subscriptions.app, 0);
  h.unmount();
  const pending = mount(), writes = pending.stateWrites;
  pending.unmount(); await pending.resolveAfterUnmount(false);
  assert.equal(pending.stateWrites, writes);
  assert.equal(pending.loops.length, 0);
});
