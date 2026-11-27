/* Real React/ReactDOM reconciliation in a local Chromium page. Only native
 * controls and providers are replaced; the memoized feed is the actual TSX.
 * No HTTP server, live marketplace, account, or additional dependency is used.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { chromium } = require("@playwright/test");

function runtimeSources() {
  const source = (pkg, name) => fs.readFileSync(path.join(path.dirname(require.resolve(`${pkg}/package.json`)), "cjs", name), "utf8");
  return {
    react: source("react", "react.development.js"),
    "react/jsx-runtime": source("react", "react-jsx-runtime.development.js"),
    "react-dom": source("react-dom", "react-dom.development.js"),
    "react-dom/client": source("react-dom", "react-dom-client.development.js"),
    scheduler: source("scheduler", "scheduler.development.js"),
    "./actual-market-feed": ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features/marketplace/market-feed.tsx"), "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText,
    "./actual-toolbar-tools": ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features/marketplace/market-toolbar-tools.tsx"), "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText,
  };
}

test("the actual marketplace feed isolates toolbar renders while retaining feed updates and actions", {
  skip: !fs.existsSync(chromium.executablePath()) ? "Local Chromium is required for real React reconciliation evidence" : false,
  timeout: 30_000,
}, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route("**/*", route => route.abort());
  await page.setContent('<div id="app"></div>');
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.evaluate(sources => {
    const loaded = new Map();
    function require(name) {
      if (loaded.has(name)) return loaded.get(name).exports;
      if (!sources[name]) throw new Error(`Unmapped feed dependency: ${name}`);
      const module = { exports: {} };
      loaded.set(name, module);
      new Function("require", "module", "exports", "process", sources[name])(
        require, module, module.exports, { env: { NODE_ENV: "development" } },
      );
      return module.exports;
    }
    const React = require("react");
    const dom = require("react-dom");
    const { createRoot } = require("react-dom/client");
    const counts = { feed: 0, cards: 0, cardMounts: 0, overlay: 0, tools: 0 };
    const actions = [];
    const flatten = value => Array.isArray(value)
      ? Object.assign({}, ...value.map(flatten)) : value || {};
    function control(tag = "div") {
      return React.forwardRef(function NativeControl(props, ref) {
        if (props.testID === "market-toolbar-tools") counts.tools++;
        return React.createElement(tag, {
          ref, style: flatten(props.style), "data-testid": props.testID,
          "aria-label": props.accessibilityLabel,
          "aria-hidden": props.accessibilityElementsHidden,
          "data-pointer-events": props.pointerEvents,
          onClick: props.onPress,
        }, props.children);
      });
    }
    const View = control();
    const Text = control("span");
    function ActivityIndicator(props) {
      return React.createElement("span", { "aria-label": props.accessibilityLabel || "loading", role: "status" });
    }
    function ListingCard({ listing }) {
      counts.cards++;
      React.useEffect(() => { counts.cardMounts++; }, []);
      return React.createElement("article", { "data-listing": listing.id, style: { height: 90 } }, listing.title);
    }
    function Button({ title, onPress }) { return React.createElement("button", { onClick: onPress }, title); }
    function EmptyState({ title, action }) { return React.createElement("div", null, title, action); }
    function InlineNotice({ message, onRetry }) {
      return React.createElement("div", null, message, React.createElement("button", { onClick: onRetry }, "retry-notice"));
    }
    function LoadingState() { return React.createElement("span", { role: "status" }, "loading-feed"); }
    function FeedHost(props) {
      counts.feed++;
      globalThis.__lastFeedProps = props;
      const component = value => React.isValidElement(value) || value == null ? value : React.createElement(value);
      return React.createElement("section", { "data-testid": props.testID },
        React.createElement("div", { "data-testid": "feed-content", style: flatten(props.contentContainerStyle) },
          component(props.ListHeaderComponent),
          props.data.length ? props.data.map((item, index) => React.createElement(React.Fragment,
            { key: props.keyExtractor(item, index) }, props.renderItem({ item, index }),
            index < props.data.length - 1 ? component(props.ItemSeparatorComponent) : null)) : component(props.ListEmptyComponent),
          component(props.ListFooterComponent)));
    }
    const colors = new Proxy({ primary: "#207968", surface: "#ffffff", muted: "#60736d" }, { get: (object, key) => object[key] || "#203832" });
    const native = { View, ActivityIndicator,
      RefreshControl: () => null,
      StyleSheet: { create: styles => styles, absoluteFill: { position: "absolute", inset: 0 } },
      Platform: { OS: "web" },
    };
    loaded.set("react-native", { exports: native });
    const reactions = new Set();
    loaded.set("react-native-reanimated", { exports: {
      __esModule: true, default: { FlatList: FeedHost }, runOnJS: callback => callback,
      // Native worklet delivery is the boundary. React's state update and
      // reconciliation inside the actual tools component remain real.
      useAnimatedReaction(prepare, react) {
        const current = React.useRef({ prepare, react });
        current.current = { prepare, react };
        React.useEffect(() => {
          let previous = null;
          const notify = () => { const value = current.current.prepare(); current.current.react(value, previous); previous = value; };
          reactions.add(notify); notify();
          return () => { reactions.delete(notify); };
        }, []);
      },
    } });
    loaded.set("../../ui/theme-context", { exports: {
      useTheme: () => ({ colors }),
      createThemedStyles: create => { const styles = create(colors); return () => styles; },
    } });
    loaded.set("../../ui", { exports: { AppText: Text, Button, EmptyState, InlineNotice, LoadingState, ListingCard,
      Icon: () => null, fonts: { regular: "sans-serif", medium: "sans-serif", bold: "sans-serif" } } });
    loaded.set("../../core/errors", { exports: { userMessage: (error, fallback) => error?.message || fallback } });
    const { MarketFeed } = require("./actual-market-feed");
    const { MarketToolbarTools } = require("./actual-toolbar-tools");
    if (!MarketFeed) throw new Error("The actual named MarketFeed export is missing");
    const initialItems = [
      { id: "first", title: "First card", images: [] },
      { id: "second", title: "Second card", images: [] },
    ];
    const props = {
      items: initialItems, feedRef: { current: null },
      onScroll: () => actions.push("scroll"),
      onFeedLayout: () => actions.push("layout"),
      onFeedContentSize: () => actions.push("content-size"),
      leadingSpace: 186, minimumContentHeight: 980, bottomInset: 24,
      refreshing: false, onRefresh: () => actions.push("refresh"),
      onRetry: () => actions.push("retry"),
      onLoadMore: () => actions.push("load-more"),
      onRetryMore: () => actions.push("retry-more"),
      onShowAll: () => actions.push("show-all"),
      query: "", hasFilters: false, isPending: false, isError: false, error: null,
      isRefetchError: false, isFetchingNextPage: false, isFetchNextPageError: false, hasNextPage: true,
    };
    const root = createRoot(document.getElementById("app"));
    let overlayValue = false;
    const hidden = { value: false, get() { return this.value; } };
    function Overlay({ collapsed }) {
      counts.overlay++;
      return React.createElement("aside", { style: { position: "absolute", top: 0 } },
        React.createElement("span", null, collapsed ? "collapsed" : "expanded"),
        React.createElement(MarketToolbarTools, { hidden, height: 136 }, "market tools"));
    }
    function Screen() {
      return React.createElement(React.Fragment, null,
        React.createElement(Overlay, { collapsed: overlayValue }), React.createElement(MarketFeed, props));
    }
    const render = () => dom.flushSync(() => root.render(React.createElement(Screen)));
    render();
    globalThis.__feedHarness = {
      counts, actions, props,
      toggleOverlay() { overlayValue = !overlayValue; render(); },
      setToolsHidden(value) { hidden.value = value; dom.flushSync(() => { for (const notify of reactions) notify(); }); },
      update(changes) { Object.assign(props, changes); render(); },
      geometry() {
        const first = document.querySelector('[data-listing="first"]');
        return { firstTop: first?.getBoundingClientRect().top,
          content: flatten(globalThis.__lastFeedProps.contentContainerStyle) };
      },
    };
  }, runtimeSources());

  await t.test("toolbar-only state changes leave the feed, card mounts, and first-card geometry unchanged", async () => {
    const result = await page.evaluate(() => {
      const h = globalThis.__feedHarness;
      const before = { counts: { ...h.counts }, geometry: h.geometry(), first: document.querySelector('[data-listing="first"]') };
      for (let index = 0; index < 20; index++) h.toggleOverlay();
      return { before: { counts: before.counts, geometry: before.geometry }, after: { counts: h.counts, geometry: h.geometry() },
        sameFirstNode: before.first === document.querySelector('[data-listing="first"]') };
    });
    assert.equal(result.before.counts.feed, 1);
    assert.equal(result.after.counts.overlay, result.before.counts.overlay + 20);
    assert.equal(result.after.counts.feed, result.before.counts.feed);
    assert.equal(result.after.counts.cards, result.before.counts.cards);
    assert.equal(result.after.counts.cardMounts, result.before.counts.cardMounts);
    assert.deepEqual(result.after.geometry, result.before.geometry);
    assert.equal(result.sameFirstNode, true);
  });

  await t.test("the actual toolbar tools visibility updates its own subtree without rendering cards or changing the first-card anchor", async () => {
    const result = await page.evaluate(() => {
      const h = globalThis.__feedHarness;
      const before = { counts: { ...h.counts }, geometry: h.geometry() };
      h.setToolsHidden(true);
      const node = document.querySelector('[data-testid="market-toolbar-tools"]');
      const hidden = { pointerEvents: node.dataset.pointerEvents, ariaHidden: node.getAttribute("aria-hidden") };
      h.setToolsHidden(false);
      return { before, hidden, after: { counts: h.counts, geometry: h.geometry() },
        visible: { pointerEvents: node.dataset.pointerEvents, ariaHidden: node.getAttribute("aria-hidden") } };
    });
    assert.ok(result.after.counts.tools >= result.before.counts.tools + 2);
    assert.equal(result.after.counts.feed, result.before.counts.feed);
    assert.equal(result.after.counts.cards, result.before.counts.cards);
    assert.equal(result.after.counts.cardMounts, result.before.counts.cardMounts);
    assert.deepEqual(result.after.geometry, result.before.geometry);
    assert.deepEqual(result.hidden, { pointerEvents: "none", ariaHidden: "true" });
    assert.deepEqual(result.visible, { pointerEvents: "auto", ariaHidden: "false" });
  });

  await t.test("next-page loading and new inventory still update the feed without remounting existing card nodes", async () => {
    const result = await page.evaluate(() => {
      const h = globalThis.__feedHarness;
      const before = { feed: h.counts.feed, first: document.querySelector('[data-listing="first"]'), mounts: h.counts.cardMounts };
      h.update({ isFetchingNextPage: true });
      const loadingFeed = h.counts.feed;
      h.update({ isFetchingNextPage: false, items: [...h.props.items, { id: "third", title: "Next page card", images: [] }] });
      return { beforeFeed: before.feed, loadingFeed, finalFeed: h.counts.feed,
        sameFirstNode: before.first === document.querySelector('[data-listing="first"]'),
        ids: [...document.querySelectorAll("[data-listing]")].map(node => node.dataset.listing),
        beforeMounts: before.mounts, afterMounts: h.counts.cardMounts };
    });
    assert.ok(result.loadingFeed > result.beforeFeed);
    assert.ok(result.finalFeed > result.loadingFeed);
    assert.equal(result.sameFirstNode, true);
    assert.deepEqual(result.ids, ["first", "second", "third"]);
    assert.equal(result.afterMounts, result.beforeMounts + 1);
  });

  await t.test("scroll, measurements, refresh, and loading actions retain their live callbacks", async () => {
    const actions = await page.evaluate(() => {
      const h = globalThis.__feedHarness, feed = globalThis.__lastFeedProps;
      feed.onScroll({ nativeEvent: { contentOffset: { y: 120 } } });
      feed.onLayout({ nativeEvent: { layout: { height: 700 } } });
      feed.onContentSizeChange(390, 2400);
      feed.onEndReached();
      const refresh = feed.refreshControl;
      refresh.props.onRefresh();
      return h.actions;
    });
    assert.deepEqual(actions, ["scroll", "layout", "content-size", "load-more", "refresh"]);
    await page.getByRole("button", { name: "تحميل المزيد", exact: true }).click();
    assert.equal(await page.evaluate(() => globalThis.__feedHarness.actions.at(-1)), "load-more");
  });

  await t.test("next-page retry and clearing empty filters retain their distinct live actions", async () => {
    await page.evaluate(() => globalThis.__feedHarness.update({ isFetchNextPageError: true }));
    await page.getByRole("button", { name: "retry-notice", exact: true }).click();
    assert.equal(await page.evaluate(() => globalThis.__feedHarness.actions.at(-1)), "retry-more");
    await page.evaluate(() => globalThis.__feedHarness.update({ items: [], hasFilters: true, isFetchNextPageError: false, hasNextPage: false }));
    await page.getByRole("button", { name: "عرض الكل", exact: true }).click();
    assert.equal(await page.evaluate(() => globalThis.__feedHarness.actions.at(-1)), "show-all");
  });

  assert.deepEqual(errors, []);
});
