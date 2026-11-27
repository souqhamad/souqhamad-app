const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

// Execute the real hook against deterministic UI events. The mock preserves
// Reanimated's cancellation callback and its completion-before-mappers order;
// it does not reproduce the toolbar's movement or reset calculations.
function toolbarHarness({ reduceMotion = false } = {}) {
  const slots = [];
  const effects = [];
  const mutables = new Set();
  const reactions = new Set();
  const frameCallbacks = new Set();
  const modules = new Map();
  const scrolls = [];
  let cursor = 0;
  let dirty = false;
  let collecting = null;
  let clock = 0;
  let ui;
  let nativeOffset = 0;
  let contentHeight = 2600;
  let viewportHeight = 600;
  const props = { feed: () => {}, categoryRows: 1, locked: false, manualLocked: false, onManualStart() {} };
  const equalDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => value === b[index]);
  const cancel = mutable => {
    const previous = mutable.animation;
    if (!previous) return;
    mutable.animation = null;
    previous.callback?.(false);
  };
  const react = {
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], value => {
        const next = typeof value === "function" ? value(slots[index]) : value;
        if (next !== slots[index]) { slots[index] = next; dirty = true; }
      }];
    },
    useCallback(fn, dependencies) {
      const index = cursor++;
      if (!equalDeps(slots[index]?.dependencies, dependencies)) slots[index] = { fn, dependencies };
      return slots[index].fn;
    },
    useEffect(fn, dependencies) {
      const index = cursor++;
      if (equalDeps(slots[index]?.dependencies, dependencies)) return;
      slots[index]?.cleanup?.();
      slots[index] = { dependencies };
      effects.push(() => { slots[index].cleanup = fn(); });
    },
  };
  const event = () => ({
    contentOffset: { x: 0, y: nativeOffset },
    contentSize: { width: 360, height: contentHeight },
    layoutMeasurement: { width: 360, height: viewportHeight },
  });
  const animated = {
    Easing: { cubic: value => value ** 3, quad: value => value ** 2, out: easing => value => 1 - easing(1 - value) },
    runOnUI: fn => fn,
    runOnJS: fn => fn,
    cancelAnimation: cancel,
    useSharedValue(initial) {
      const index = cursor++;
      if (!(index in slots)) {
        const mutable = {
          current: initial, version: 0, animation: null,
          get() { collecting?.add(this); return this.current; },
          set(value) {
            cancel(this);
            if (typeof value === "function") value = value(this.current);
            if (value?.__timing) {
              if (value.target === this.current) { value.callback?.(true); return; }
              this.animation = { ...value, start: this.current, startedAt: clock };
            } else if (value !== this.current) { this.current = value; this.version++; }
          },
          get value() { return this.get(); },
          set value(value) { this.set(value); },
        };
        slots[index] = mutable;
        mutables.add(mutable);
      }
      return slots[index];
    },
    useDerivedValue(prepare) {
      const index = cursor++;
      if (!(index in slots)) {
        const value = {
          current: prepare(), version: 0,
          get() { collecting?.add(this); return this.current; },
          get value() { return this.get(); },
        };
        const reaction = {
          initialized: false, dependencies: new Map(), previous: undefined,
          prepare,
          reactToValue(next) {
            if (next !== value.current) { value.current = next; value.version++; }
          },
        };
        slots[index] = { value, reaction };
        reactions.add(reaction);
      }
      slots[index].reaction.prepare = prepare;
      return slots[index].value;
    },
    useAnimatedReaction(prepare, reactToValue) {
      const index = cursor++;
      if (!(index in slots)) {
        slots[index] = { initialized: false, dependencies: new Map(), previous: undefined };
        reactions.add(slots[index]);
      }
      Object.assign(slots[index], { prepare, reactToValue });
    },
    useAnimatedStyle(fn) { cursor++; return fn; },
    useReducedMotion() { cursor++; return reduceMotion; },
    useFrameCallback(callback, autostart = true) {
      const index = cursor++;
      if (!(index in slots)) {
        const entry = { callback, isActive: autostart, previous: null,
          setActive(active) { if (active && !this.isActive) this.previous = null; this.isActive = active; } };
        slots[index] = entry;
        frameCallbacks.add(entry);
      }
      slots[index].callback = callback;
      return slots[index];
    },
    useAnimatedScrollHandler(handlers) { cursor++; return handlers; },
    withTiming(target, options, callback) { return { __timing: true, target, options, callback }; },
    scrollTo(_ref, _x, y, animatedScroll) {
      assert.equal(animatedScroll, false, "Top-card compensation must not start a second scroll animation");
      nativeOffset = Math.max(0, Math.min(Math.max(0, contentHeight - viewportHeight), y));
      scrolls.push(nativeOffset);
      ui?.onScroll.onScroll(event());
    },
  };
  function readModule(filename) {
    if (modules.has(filename)) return modules.get(filename);
    const module = { exports: {} };
    modules.set(filename, module.exports);
    const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(javascript, {
      exports: module.exports, module,
      require: name => {
        if (name === "react") return react;
        if (name === "react-native-reanimated") return animated;
        if (name === "react-native-gesture-handler") return { usePanGesture: config => { cursor++; return config; } };
        if (name === "./toolbar-motion") return readModule(path.resolve(path.dirname(filename), "toolbar-motion.ts"));
        throw Error(`Unexpected hook dependency: ${name}`);
      },
    }, { filename });
    return module.exports;
  }
  const { useMarketToolbar: invokeToolbar } = readModule(path.resolve(__dirname, "../src/features/marketplace/use-market-toolbar.ts"));
  let renders = 0;
  function render() { renders++; cursor = 0; ui = invokeToolbar(props); dirty = false; }
  function flush() {
    for (let iteration = 0; iteration < 100; iteration++) {
      let changed = false;
      if (dirty) { render(); changed = true; }
      while (effects.length) { effects.shift()(); changed = true; }
      for (const reaction of reactions) {
        if (reaction.initialized && [...reaction.dependencies].every(([mutable, version]) => mutable.version === version)) continue;
        const dependencies = new Set();
        collecting = dependencies;
        const prepared = reaction.prepare();
        collecting = null;
        reaction.dependencies = new Map([...dependencies].map(mutable => [mutable, mutable.version]));
        const previous = reaction.initialized ? reaction.previous : null;
        reaction.previous = prepared;
        reaction.initialized = true;
        reaction.reactToValue(prepared, previous);
        changed = true;
      }
      if (!changed) return;
    }
    throw Error("Toolbar UI effects did not settle");
  }
  const api = {
    get renders() { return renders; },
    get activeFrameCallbacks() { return [...frameCallbacks].filter(frame => frame.isActive).length; },
    get visibleTools() { return ui.toolsHeight + ui.toolbarStyle().transform[0].translateY; },
    get toolbarStyle() { return ui.toolbarStyle(); },
    get styleInputs() {
      const dependencies = new Set();
      collecting = dependencies;
      try { ui.toolbarStyle(); } finally { collecting = null; }
      return new Map([...dependencies].map(value => [value, value.version]));
    },
    get toolsHidden() { return ui.toolsHidden.get(); },
    get layout() {
      return { toolsHeight: ui.toolsHeight, leadingSpace: ui.leadingSpace,
        categoryHeight: ui.categoryHeight, minimumContentHeight: ui.minimumContentHeight };
    },
    get offset() { return nativeOffset; },
    scrolls,
    measureTools(height) { ui.measureTools(height); flush(); },
    measureContent(height) { contentHeight = height; ui.measureContent(height); flush(); },
    setProps(next) { Object.assign(props, next); dirty = true; flush(); },
    reset() { ui.resetFeed(); flush(); },
    scrollTo(y, beginDrag = false) {
      if (beginDrag) ui.onScroll.onBeginDrag(event());
      nativeOffset = y;
      ui.onScroll.onScroll(event());
      flush();
    },
    activate() { ui.gesture.onActivate({ translationY: 0 }); flush(); },
    pan(translationY) { ui.gesture.onUpdate({ translationY }); flush(); },
    release(velocityY) { ui.gesture.onDeactivate({ velocityY, canceled: false }); flush(); },
    advance(milliseconds, beforeFrame) {
      const stopAt = clock + milliseconds;
      while (clock < stopAt) {
        clock = Math.min(stopAt, clock + 16);
        beforeFrame?.();
        for (const mutable of mutables) {
          const animation = mutable.animation;
          if (!animation) continue;
          const progress = Math.min(1, (clock - animation.startedAt) / (animation.options.duration ?? 300));
          const eased = animation.options.easing ? animation.options.easing(progress) : progress;
          mutable.current = animation.start + (animation.target - animation.start) * eased;
          mutable.version++;
          if (progress === 1) {
            mutable.animation = null;
            animation.callback?.(true);
          }
        }
        for (const frame of frameCallbacks) {
          if (!frame.isActive) continue;
          const previous = frame.previous;
          frame.previous = clock;
          frame.callback({ timestamp: clock, timeSincePreviousFrame: previous === null ? null : clock - previous, timeSinceFirstFrame: clock });
        }
        flush();
      }
    },
  };
  render(); flush();
  ui.measureFeed(viewportHeight); ui.measureContent(contentHeight); flush();
  return api;
}

test("a new feed goal on every display frame does not restart and starve the toolbar motion", () => {
  const app = toolbarHarness();
  app.scrollTo(600, true); app.advance(1200);
  assert.equal(app.visibleTools, 0);
  const positions = [];
  for (let step = 1; step <= 30; step++) {
    app.advance(16, () => app.scrollTo(600 - step * 3));
    positions.push(app.visibleTools);
  }
  assert.ok(positions[29] > 40, "Continuous scroll events must allow the tools to advance");
  for (let index = 6; index < positions.length; index++) {
    assert.ok(positions[index] > positions[index - 1], "Following a moving goal must advance on each frame after direction confirmation");
  }
  app.advance(1200);
  assert.ok(Math.abs(app.visibleTools - 90) < 0.5);
  assert.equal(app.activeFrameCallbacks, 0, "Settled tools must not keep scheduling display callbacks");
});

test("reduced motion updates automatic toolbar goals without a background display loop", () => {
  const app = toolbarHarness({ reduceMotion: true });
  app.scrollTo(600, true);
  assert.equal(app.visibleTools, 0);
  app.scrollTo(550);
  assert.equal(app.visibleTools, 50);
  assert.equal(app.activeFrameCallbacks, 0);
});

test("scrolling beyond settled tools does not schedule identical native transforms", () => {
  const app = toolbarHarness();
  app.scrollTo(500, true);
  app.advance(1000);
  assert.equal(app.visibleTools, 0);
  const settled = app.styleInputs;
  assert.ok(settled.size > 0, "The visible toolbar still needs an animated style input");
  for (let y = 520; y <= 900; y += 20) app.scrollTo(y);
  for (const [input, version] of settled) {
    assert.equal(input.version, version, "An unchanged toolbar must not invalidate its native style mapper");
  }
  app.scrollTo(820);
  app.advance(500);
  assert.ok(app.visibleTools > 0, "Reversing the feed must still reopen the tools");
  assert.ok([...settled].some(([input, version]) => input.version !== version));
});

test("resizing tools during manual settling completes the resized endpoint and releases automatic following", () => {
  const app = toolbarHarness();
  app.scrollTo(1000, true);
  app.advance(1000);
  assert.equal(app.visibleTools, 0);
  app.activate(); app.pan(70); app.release(-700);
  assert.ok(app.visibleTools > 20, "Fixture must resize while the tools are still between endpoints");
  app.measureTools(160);
  app.advance(1000);
  assert.equal(app.visibleTools, 0, "A changed banner/notice height must not strand the tools mid-settle");
  app.scrollTo(950);
  app.advance(1000);
  assert.ok(app.visibleTools >= 49, "Reverse feed movement must follow again after the resized settle");
});

test("a collapsed category reset keeps tools collapsed and aligns the new first card after remeasurement", () => {
  const app = toolbarHarness();
  app.scrollTo(850, true);
  app.advance(1000);
  assert.equal(app.visibleTools, 0);
  app.setProps({ categoryRows: 2 });
  app.reset();
  assert.equal(app.visibleTools, 0, "Selecting a category must not reopen the upper tools");
  assert.equal(app.offset, 136, "The fixed feed header requires a reset to the retained collapsed distance");
  app.measureTools(160);
  app.measureContent(760);
  app.advance(1000);
  assert.equal(app.visibleTools, 0);
  assert.equal(app.offset, 160, "New filter controls must not leave a gap before the first card");
});

test("a reset while search owns the tools still expands them and restores the first card", () => {
  const app = toolbarHarness();
  app.scrollTo(850, true);
  app.advance(1000);
  app.setProps({ locked: true });
  app.reset();
  app.advance(1000);
  assert.equal(app.visibleTools, 136, "A focused search must retain its expanded tools");
  assert.equal(app.offset, 0);
});

test("a content shrink clamps a deep feed without treating the clamp as a reverse user scroll", () => {
  const app = toolbarHarness();
  app.scrollTo(1000, true);
  app.advance(1000);
  assert.equal(app.visibleTools, 0);
  app.measureContent(760);
  // React Native clamps the native offset when a shorter result set replaces
  // the old one. That layout event can arrive before the query-reset effect.
  app.scrollTo(160);
  assert.equal(app.visibleTools, 0, "A shorter result set must not reopen tools before the filter reset captures their position");
  app.scrollTo(110);
  app.advance(1000);
  assert.ok(Math.abs(app.visibleTools - 50) < 0.01, "A subsequent real reverse scroll must reveal tools from the clamped position");
});

test("remeasuring an active manual drag does not turn concurrent feed events into automatic toolbar movement", () => {
  const app = toolbarHarness();
  app.scrollTo(1000, true);
  app.advance(1000);
  app.activate(); app.pan(40);
  app.measureTools(160);
  const controlledHeight = app.visibleTools;
  app.scrollTo(1050);
  assert.equal(app.visibleTools, controlledHeight, "The active toolbar gesture must keep control while its height changes");
  app.pan(70);
  assert.ok(app.visibleTools > controlledHeight, "Continuing the same downward gesture must continue revealing the tools");
  app.release(-700); app.advance(1000);
  assert.equal(app.visibleTools, 0);
});

test("fast card scrolling moves the toolbar progressively with a bounded speed and no overshoot", () => {
  const app = toolbarHarness();
  app.scrollTo(1000, true);
  assert.equal(app.visibleTools, 136, "The scroll event must set a goal instead of jumping the tools to it");
  let previous = app.visibleTools;
  let movingFrames = 0;
  for (let frame = 0; frame < 75; frame++) {
    app.advance(16);
    const current = app.visibleTools;
    const movement = previous - current;
    assert.ok(movement >= -0.001, "A forward card scroll must not make the tools bounce down");
    assert.ok(movement <= 360 * 0.016 + 0.02, "Each frame must respect the calm automatic speed limit");
    assert.ok(current >= 0 && current <= 136, "Automatic movement must never overshoot its endpoints");
    if (movement > 0.05) movingFrames++;
    previous = current;
  }
  assert.ok(movingFrames > 10, "A full slide must visibly span many frames");
  assert.equal(app.visibleTools, 0);
  app.advance(1000);
  assert.equal(app.visibleTools, 0, "The tools must stop after reaching their goal");
});

test("alternating six-point card movements leave a partially shown toolbar still", () => {
  const app = toolbarHarness();
  app.scrollTo(1000, true); app.advance(1000);
  app.scrollTo(950); app.advance(1000);
  const before = app.visibleTools;
  assert.ok(before > 20 && before < 100, "Noise must be tested between the endpoints");
  for (let index = 0; index < 12; index++) {
    app.scrollTo(956); app.advance(80);
    assert.ok(Math.abs(app.visibleTools - before) < 0.01, "A tiny forward wiggle must not move the tools");
    app.scrollTo(950); app.advance(80);
    assert.ok(Math.abs(app.visibleTools - before) < 0.01, "A tiny reverse wiggle must not create an oscillation");
  }
  app.advance(1000);
  assert.ok(Math.abs(app.visibleTools - before) < 0.01, "Ignored noise must not leave a delayed slide");
});

test("a reverse becomes a gradual reveal only after a clear accumulated card movement", () => {
  const app = toolbarHarness();
  app.scrollTo(1000, true); app.advance(1000);
  app.scrollTo(994); app.advance(200);
  assert.equal(app.visibleTools, 0);
  app.scrollTo(988); app.advance(200);
  assert.equal(app.visibleTools, 0, "Twelve reverse points must remain below the direction threshold");
  app.scrollTo(984);
  assert.equal(app.visibleTools, 0, "A confirmed reverse must begin an animation rather than jump");
  app.advance(16);
  assert.ok(app.visibleTools > 0 && app.visibleTools < 16, "The first reveal frame must be intermediate");
  app.advance(1000);
  assert.ok(Math.abs(app.visibleTools - 16) < 0.01);
});

test("a confirmed reverse interrupts a pending old goal from the current toolbar position", () => {
  const app = toolbarHarness();
  app.scrollTo(1000, true); app.advance(96);
  const before = app.visibleTools;
  assert.ok(before > 30 && before < 136, "The old automatic slide must still be in progress");
  app.scrollTo(970);
  app.advance(32);
  assert.ok(app.visibleTools > before, "A confirmed reverse must reveal immediately instead of chasing the old closed goal");
});

test("manual dragging remains direct and cannot resume an older automatic goal afterward", () => {
  const app = toolbarHarness();
  app.scrollTo(1000, true); app.advance(96);
  const before = app.visibleTools;
  app.activate(); app.pan(20);
  assert.ok(Math.abs(app.visibleTools - Math.min(136, before + 20)) < 0.01, "The finger must move the tools directly without automatic smoothing lag");
  const controlled = app.visibleTools;
  app.advance(1000);
  assert.equal(app.visibleTools, controlled, "An old automatic goal must not fight an active manual drag");
  app.release(700); app.advance(1000);
  assert.equal(app.visibleTools, 136);
  app.advance(1000);
  assert.equal(app.visibleTools, 136, "The previous automatic closed goal must stay canceled after release");
});

test("automatic toolbar movement changes its transform without changing measured toolbar or feed dimensions", () => {
  const app = toolbarHarness();
  const layout = app.layout;
  app.scrollTo(1000, true);
  for (let frame = 0; frame < 60; frame++) {
    app.advance(16);
    assert.deepEqual(app.layout, layout, "Scrolling the cards must not remeasure the toolbar or resize the feed header");
    assert.deepEqual(Object.keys(app.toolbarStyle), ["transform"], "The moving toolbar must not animate a layout height");
    assert.deepEqual(Object.keys(app.toolbarStyle.transform[0]), ["translateY"]);
  }
  assert.equal(app.visibleTools, 0);
  app.scrollTo(850);
  app.advance(1000);
  assert.deepEqual(app.layout, layout);
  assert.equal(app.visibleTools, 136);
});

test("animated visibility changes never update React state in the marketplace controller", () => {
  const app = toolbarHarness();
  const before = app.renders;
  app.scrollTo(1000, true);
  app.advance(1000);
  assert.equal(app.toolsHidden, true);
  app.scrollTo(850);
  app.advance(1000);
  assert.equal(app.toolsHidden, false);
  assert.equal(app.renders, before, "Showing/hiding the tools must only update the isolated tools subtree");
});

test("one or two retained category rows have no spacer between toolbar and first card", () => {
  for (const categoryRows of [1, 2]) {
    const app = toolbarHarness();
    app.setProps({ categoryRows });
    const toolbarBottom = app.layout.toolsHeight + categoryRows * 40 + 2 + 8;
    assert.equal(app.layout.leadingSpace, toolbarBottom);
    app.activate();
    app.pan(-50);
    const translatedBottom = toolbarBottom - (app.layout.toolsHeight - app.visibleTools);
    assert.equal(app.layout.leadingSpace - app.offset, translatedBottom);
    app.release(-700);
    app.advance(1000);
    assert.ok(Math.abs(app.layout.leadingSpace - app.offset - (toolbarBottom - app.layout.toolsHeight)) < 0.25,
      "The settled first card must meet the toolbar within the existing native scroll tolerance");
  }
});

test("card scrolling and momentum never issue competing native feed scroll commands", () => {
  const app = toolbarHarness();
  for (const [index, nativeOffset] of [1000, 1040, 1100, 1040, 950, 650, 280, 100, 50, 0].entries()) {
    app.scrollTo(nativeOffset, index === 0);
    for (let frame = 0; frame < 32; frame++) {
      app.advance(16);
      assert.equal(app.offset, nativeOffset, "Only the caller's native card movement may determine the feed offset");
      assert.equal(app.scrolls.length, 0, "An automatic toolbar frame must not call scrollTo on the feed");
    }
  }
  app.advance(1000);
  assert.equal(app.visibleTools, 136);
  assert.equal(app.offset, 0);
  assert.equal(app.scrolls.length, 0);
});

test("focusing search after a near-start geometry clamp begins at the rendered toolbar position", () => {
  const app = toolbarHarness();
  app.scrollTo(1000, true); app.advance(1000);
  assert.equal(app.toolsHidden, true);
  app.measureContent(650);
  app.scrollTo(50);
  const visible = app.visibleTools;
  assert.equal(visible, 86, "The toolbar must remain attached to the first card after the native clamp");
  assert.equal(app.toolsHidden, false, "Visibly revealed tools must also become accessible");
  app.setProps({ locked: true });
  assert.equal(app.visibleTools, visible, "Taking search ownership must not expose an old hidden animation position");
  app.advance(16);
  assert.ok(app.visibleTools >= visible && app.visibleTools < 136, "The focused search must reveal from the current position gradually");
  app.advance(1000);
  assert.equal(app.visibleTools, 136);
  assert.ok(app.offset <= 0.25, "The first-card offset must settle within the subpixel scroll tolerance");
});

test("changing categories near the first card preserves the rendered tools position", () => {
  const app = toolbarHarness();
  app.scrollTo(1000, true); app.advance(1000);
  app.measureContent(650);
  app.scrollTo(50);
  const visible = app.visibleTools;
  assert.equal(visible, 86);
  app.setProps({ categoryRows: 2 });
  app.reset();
  assert.equal(app.visibleTools, visible, "A category reset must not reveal the animation position hidden by the near-start bound");
  assert.equal(app.offset, 50, "The first result must start at the retained visible collapse distance");
  app.advance(1000);
  assert.equal(app.visibleTools, visible, "No old automatic goal may resume after changing categories");
});
