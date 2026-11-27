const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function declaration(file, name) {
  const filename = path.resolve(__dirname, file);
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(source);
}
const code = ts.transpileModule(`${declaration("../src/features/marketplace/listing-screen.tsx", "ListingScreen")}\n${declaration("../src/ui/index.tsx", "ListingCard")}\nmodule.exports = { ListingScreen, ListingCard };`, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const fixture = (id, fields = {}) => ({ id, sellerId: "seller", category: "cars", status: "published", title: id, images: [], attributes: {}, ...fields });
const nodes = (node, type) => {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(child => nodes(child, type));
  return [...(node.type === type ? [node] : []), ...nodes(node.props?.children, type)];
};
const text = node => typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ? text(node.props?.children) : "";

function harness(initial = {}) {
  const queries = [], requests = [], navigations = [], effects = [];
  let base = { data: { listing: fixture("source") }, isPending: false, isError: false };
  let similar = { data: [], isPending: false, isError: false, refetch: () => { requests.push("retry-similar"); } , ...initial };
  const module = { exports: {} };
  const jsx = (type, props, key) => ({ type, props, key });
  const controls = Object.fromEntries(["View", "FlatList", "Screen", "PageHeader", "Icon", "AppText", "Button", "Card", "Pressable", "Modal", "Field", "EmptyState", "LoadingState", "Image", "ListingCardImage", "ListingNoPhoto", "ListingPhotoPlaceholder", "GalleryPreviewProvider", "ListingCardRecoveryProvider", "GestureHandlerRootView", "ListingGallery", "ProgressiveListingImage"].map(name => [name, name]));
  const photoWindow = { range: { first: 0, last: 2 }, onViewportLayout: () => {}, onScroll: () => {}, onPhotosLayout: () => {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, ...controls,
    require: name => { assert.equal(name, "react/jsx-runtime"); return { jsx, jsxs: jsx }; },
    useFeedback: () => ({}), useTheme: () => ({ colors: {} }), useStyles: () => ({}),
    useLocalSearchParams: () => ({ listingId: "source" }), useAuth: () => ({ user: null }),
    useBootstrap: () => ({ data: { categories: [] } }), useSafeAreaInsets: () => ({ bottom: 0 }),
    useQueryClient: () => ({}), useState: value => [typeof value === "function" ? value() : value, () => {}],
    useRef: current => ({ current }), useLayoutEffect: fn => effects.push(fn), useMutation: () => ({}),
    useListingPhotoWindow: () => photoWindow,
    useQuery: options => { queries.push(options); return options.queryKey[0] === "listing" ? options.queryKey[2] === "similar" ? similar : base : {}; },
    Crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" },
    api: { get: async (...args) => { requests.push(args); return { listings: [] }; } },
    parseSimilarListings: value => value.listings,
    router: { push: route => navigations.push(route) },
    fonts: {}, formatPrice: () => "price", StyleSheet: { absoluteFill: {} },
    getListingCardImageSources: () => ({}), assetUrl: value => value,
  });
  return {
    queries, requests, navigations, photoWindow,
    render: () => module.exports.ListingScreen(),
    card: item => module.exports.ListingCard({ listing: item }),
    similar: value => { similar = { ...similar, ...value }; },
    base: value => { base = { ...base, ...value }; },
  };
}

test("the actual detail places the same native cards after every old section and the ad ID", () => {
  const h = harness({ data: [fixture("first"), fixture("second")] });
  const tree = h.render();
  const list = nodes(tree, "FlatList")[0];
  assert.equal(nodes(tree, "FlatList").length, 1, "No nested vertical list is introduced");
  assert.equal(list.props.removeClippedSubviews, false, "Existing detail/gallery preview hosts remain mounted");
  assert.equal(list.props.onScroll, h.photoWindow.onScroll);
  assert.equal(list.props.onLayout, h.photoWindow.onViewportLayout);
  const headerText = text(list.props.ListHeaderComponent);
  assert.ok(headerText.endsWith("إعلانات مشابهة"));
  assert.ok(headerText.indexOf("رقم الإعلان: source") < headerText.lastIndexOf("إعلانات مشابهة"));
  const row = list.props.renderItem({ item: list.props.data[0] });
  const card = row.props.children;
  assert.equal(typeof card.type, "function");
  assert.equal(card.type.name, "ListingCard");
  assert.equal(card.props.listing, list.props.data[0]);
  assert.equal(card.props.onPress, undefined, "The shared card retains its existing Router navigation");
  assert.equal(list.props.keyExtractor(list.props.data[0]), "first");
  const actualCard = h.card(fixture("first"));
  nodes(actualCard, "Pressable")[0].props.onPress();
  assert.equal(h.navigations[0], "/listings/first");
  assert.equal(nodes(tree, "PageHeader")[0].props.title, "تفاصيل الإعلان");
  assert.ok(nodes(tree, "Button").some(node => node.props.title === "راسل المعلن"));
});

test("zero matches hide the section and independent loading/errors preserve the same detail key", () => {
  const h = harness();
  const empty = nodes(h.render(), "FlatList")[0];
  assert.equal(empty.props.data.length, 0);
  assert.ok(!text(empty.props.ListHeaderComponent).includes("إعلانات مشابهة"));
  assert.equal(empty.props.ListFooterComponent, undefined);
  h.similar({ isPending: true });
  const loading = nodes(h.render(), "FlatList")[0];
  assert.equal(loading.key, empty.key);
  assert.equal(loading.props.ListHeaderComponent.type, empty.props.ListHeaderComponent.type);
  assert.ok(text(loading.props.ListFooterComponent).includes("جارٍ تحميل"));
  h.similar({ isPending: false, isError: true });
  const failed = nodes(h.render(), "FlatList")[0];
  assert.equal(failed.key, empty.key);
  assert.ok(text(failed.props.ListHeaderComponent).includes("source"));
  nodes(failed.props.ListFooterComponent, "Button")[0].props.onPress();
  assert.equal(h.requests.at(-1), "retry-similar");
});

test("public similar reads use the existing endpoint and a separate cancellable cache key", async () => {
  const h = harness(); h.render();
  const query = h.queries.find(query => query.queryKey[2] === "similar");
  assert.deepEqual(Array.from(query.queryKey), ["listing", "source", "similar"]);
  assert.equal(query.enabled, true, "Guest browsing requires no follow or account");
  const controller = new AbortController();
  await query.queryFn({ signal: controller.signal });
  assert.equal(h.requests[0][0], "/api/marketplace/listings/source");
  assert.equal(h.requests[0][1].view, "similar");
  assert.equal(h.requests[0][2].signal, controller.signal);
  h.base({ data: { listing: fixture("source", { status: "draft" }) } });
  h.render();
  assert.equal(h.queries.filter(query => query.queryKey[2] === "similar").at(-1).enabled, false);
});
