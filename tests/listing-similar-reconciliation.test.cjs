/* Real React reconciliation with local native-host substitutes. No server,
 * account, production data or dependency installation is involved. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { chromium } = require("@playwright/test");

function sources() {
  const runtime = (pkg, filename) => fs.readFileSync(path.join(path.dirname(require.resolve(`${pkg}/package.json`)), "cjs", filename), "utf8");
  const filename = path.resolve(__dirname, "../src/features/marketplace/listing-screen.tsx");
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const screen = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "ListingScreen").getText(source);
  const styles = source.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(source) === "useStyles")).getText(source);
  return {
    react: runtime("react", "react.development.js"), "react/jsx-runtime": runtime("react", "react-jsx-runtime.development.js"),
    "react-dom": runtime("react-dom", "react-dom.development.js"), "react-dom/client": runtime("react-dom", "react-dom-client.development.js"),
    scheduler: runtime("scheduler", "scheduler.development.js"),
    recovery: ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/ui/listing-card-recovery.tsx"), "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText,
    actual: ts.transpileModule(`const { useState, useRef, useLayoutEffect } = require("react");\nconst { View, FlatList, Screen, PageHeader, Icon, AppText, Button, Card, Pressable, Modal, Field, EmptyState, LoadingState, Image, GalleryPreviewProvider, ListingCardRecoveryProvider, GestureHandlerRootView, ListingGallery, ProgressiveListingImage, ListingCard, useFeedback, useTheme, useLocalSearchParams, useAuth, useBootstrap, useSafeAreaInsets, useQueryClient, useMutation, useListingPhotoWindow, useQuery, api, parseSimilarListings, router, fonts, formatPrice, StyleSheet, getListingImageSources, assetUrl, createThemedStyles, listingPhotoHeight, listingPhotoGap, Crypto } = require("hosts");\n${styles}\n${screen}`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText,
  };
}

test("similar results retain the actual detail hosts, gallery selection and return scroll position", {
  skip: !fs.existsSync(chromium.executablePath()) ? "Local Chromium required for React reconciliation" : false,
  timeout: 30_000,
}, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route("**/*", route => route.abort());
  await page.setContent('<style>body{margin:0}*{box-sizing:border-box}</style><div id="root"></div>');
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.evaluate(sources => {
    const loaded = new Map();
    function require(name) {
      if (loaded.has(name)) return loaded.get(name).exports;
      if (!sources[name]) throw new Error(`Unknown dependency ${name}`);
      const module = { exports: {} }; loaded.set(name, module);
      new Function("require", "module", "exports", "process", sources[name])(require, module, module.exports, { env: { NODE_ENV: "development" } });
      return module.exports;
    }
    const React = require("react"), dom = require("react-dom"), { createRoot } = require("react-dom/client");
    loaded.set("../core/visible-query", { exports: { useScreenActive: () => true } });
    loaded.set("expo-network", { exports: {} });
    const { ListingCardRecoveryProvider } = require("recovery");
    const counts = { provider: 0, photos: 0 }, routes = [];
    const flatten = value => {
      const result = Array.isArray(value) ? Object.assign({}, ...value.map(flatten)) : { ...value };
      if (typeof result.lineHeight === "number") result.lineHeight = `${result.lineHeight}px`;
      return result;
    };
    function View(props) { return React.createElement("div", { style: { display: "flex", flexDirection: "column", position: "relative", ...flatten(props.style) }, onClick: props.onPress, "aria-label": props.accessibilityLabel }, props.children); }
    function AppText(props) { return React.createElement("span", { style: { fontSize: 14, lineHeight: "24px", textAlign: "right", ...flatten(props.style) } }, props.children); }
    function Button(props) { return React.createElement("button", { onClick: props.onPress, style: { height: 44, flexShrink: 0 } }, props.title); }
    function FlatList(props) {
      globalThis.__listProps = props;
      const element = value => React.isValidElement(value) || value == null ? value : React.createElement(value);
      return React.createElement("div", { "data-testid": "detail-scroll", style: { ...flatten(props.style), overflowY: "auto", minHeight: 0 } },
        React.createElement("div", { style: flatten(props.contentContainerStyle) },
          React.createElement("div", { key: "$header", "data-testid": "detail-header" }, element(props.ListHeaderComponent)),
          props.data.map(item => React.createElement(React.Fragment, { key: props.keyExtractor(item) }, props.renderItem({ item }))),
          element(props.ListFooterComponent)));
    }
    function GalleryPreviewProvider(props) { React.useEffect(() => { counts.provider++; }, []); return props.children; }
    function ProgressiveListingImage(props) {
      React.useEffect(() => { counts.photos++; }, []);
      const layers = React.createElement("div", { "data-photo": props.previewSource, style: { height: "100%" } });
      return props.renderImage(layers);
    }
    function ListingGallery(props) { return React.createElement("button", { "data-testid": "open-gallery", "data-index": props.initialIndex, onClick: props.onClose }, "Close viewer"); }
    function ListingCard({ listing }) { return React.createElement("button", { "data-listing": listing.id, style: { height: 140, width: "100%" }, onClick: () => routes.push(`/listings/${listing.id}`) }, listing.title); }
    const colors = new Proxy({}, { get: (_target, key) => key === "surface" ? "white" : "#207968" });
    const sourceListing = { id: "source", sellerId: "seller", category: "cars", status: "published", title: "Current listing", description: "Details stay first", attributes: {}, images: [0, 1].map(id => ({ id: `photo-${id}`, status: "approved", displayUrl: `display-${id}`, thumbnailUrl: `thumb-${id}` })) };
    let similar = { isPending: true, data: undefined, isError: false };
    const hosts = {
      View, AppText, Button, FlatList, GalleryPreviewProvider, ListingCardRecoveryProvider, ProgressiveListingImage, ListingGallery, ListingCard,
      Crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" },
      Screen: props => props.scroll ? null : React.createElement(View, { style: { height: 844, position: "relative", overflow: "hidden" } }, props.children),
      PageHeader: props => React.createElement("header", { style: { height: 52, flexShrink: 0 } }, props.title),
      Card: props => React.createElement(View, { style: { padding: 12, ...flatten(props.style) } }, props.children),
      Pressable: View, Icon: () => null, Image: () => null, Field: () => null, EmptyState: () => null, LoadingState: () => null,
      GestureHandlerRootView: View,
      Modal: props => props.visible ? React.createElement("div", { style: { position: "fixed", inset: 0, zIndex: 20, background: "white" } }, props.children) : null,
      useFeedback: () => ({}), useTheme: () => ({ colors }),
      useLocalSearchParams: () => ({ listingId: "source" }), useAuth: () => ({ user: null }), useBootstrap: () => ({ data: { categories: [] } }),
      useSafeAreaInsets: () => ({ bottom: 34 }), useQueryClient: () => ({}), useMutation: () => ({}),
      useListingPhotoWindow: () => ({ range: { first: 0, last: 1 }, onScroll: () => {}, onViewportLayout: () => {}, onPhotosLayout: () => {} }),
      useQuery: options => options.queryKey[0] === "listing" ? options.queryKey[2] === "similar" ? similar : { data: { listing: sourceListing } } : {},
      api: {}, parseSimilarListings: () => [], router: { push: route => routes.push(route) }, fonts: {}, formatPrice: () => "100 ريال",
      StyleSheet: { create: value => value, absoluteFill: { position: "absolute", inset: 0 } },
      getListingImageSources: photo => ({ previewSource: photo.displayUrl }), assetUrl: value => value,
      createThemedStyles: create => { const styles = create(colors); return () => styles; }, listingPhotoHeight: 210, listingPhotoGap: 10,
    };
    loaded.set("hosts", { exports: hosts });
    const ListingScreen = require("actual").default;
    const root = createRoot(document.getElementById("root"));
    const render = () => dom.flushSync(() => root.render(React.createElement(ListingScreen)));
    render();
    globalThis.__detailHarness = {
      counts, routes, render,
      setSimilar(next) { similar = { ...similar, ...next, dataUpdatedAt: (similar.dataUpdatedAt ?? 0) + 1 }; render(); },
    };
  }, sources());

  await t.test("new data appends after details without remounting photos or resetting the scroll host", async () => {
    const result = await page.evaluate(() => {
      const h = globalThis.__detailHarness, scroll = document.querySelector('[data-testid="detail-scroll"]');
      scroll.scrollTop = 220;
      const before = { top: scroll.scrollTop, counts: { ...h.counts }, photo: document.querySelector("[data-photo]") };
      h.setSimilar({ isPending: false, data: Array.from({ length: 20 }, (_, index) => ({ id: `similar-${index}`, title: `Similar ${index}` })) });
      return { before: { top: before.top, counts: before.counts }, after: { top: scroll.scrollTop, counts: h.counts }, sameHost: scroll === document.querySelector('[data-testid="detail-scroll"]'), samePhoto: before.photo === document.querySelector("[data-photo]"), order: document.querySelector('[data-testid="detail-header"]').textContent.endsWith("إعلانات مشابهة"), cards: document.querySelectorAll("[data-listing]").length };
    });
    assert.ok(result.before.top > 0);
    assert.equal(result.sameHost, true); assert.equal(result.samePhoto, true);
    assert.deepEqual(result.after, result.before);
    assert.equal(result.order, true); assert.equal(result.cards, 20);
  });

  await t.test("gallery remains selected across refetch and the final card clears the fixed contact actions", async () => {
    await page.locator('[aria-label="فتح صورة الإعلان 2 من 2"]').click();
    assert.equal(await page.locator('[data-testid="open-gallery"]').getAttribute("data-index"), "1");
    await page.evaluate(() => globalThis.__detailHarness.setSimilar({ isFetching: true }));
    assert.equal(await page.locator('[data-testid="open-gallery"]').getAttribute("data-index"), "1");
    await page.locator('[data-testid="open-gallery"]').click();
    const result = await page.evaluate(() => {
      const scroll = document.querySelector('[data-testid="detail-scroll"]'); scroll.scrollTop = scroll.scrollHeight;
      const last = document.querySelector('[data-listing="similar-19"]'), contact = [...document.querySelectorAll("button")].find(node => node.textContent === "راسل المعلن");
      const top = scroll.scrollTop; last.click(); globalThis.__detailHarness.render();
      return { lastBottom: last.getBoundingClientRect().bottom, contactTop: contact.getBoundingClientRect().top, before: top, after: scroll.scrollTop, route: globalThis.__detailHarness.routes.at(-1) };
    });
    assert.ok(result.lastBottom <= result.contactTop, `Last card bottom ${result.lastBottom} must clear contact top ${result.contactTop}`);
    assert.equal(result.before, result.after); assert.equal(result.route, "/listings/similar-19");
  });
  assert.deepEqual(errors, []);
});
