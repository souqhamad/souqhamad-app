const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

// Exercise the actual gallery component's hooks and event handlers. Native
// scrolling/gesture feel still requires device verification.
const declarations = (file, names) => {
  const filename = path.resolve(__dirname, file);
  const parsed = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.equal(found.length, names.length);
  return found.map(node => node.getText(parsed)).join("\n");
};
const code = ts.transpileModule([
  declarations("../src/ui/gallery-geometry.ts", ["resolveGallerySelection", "getGalleryNeighbourIndexes"]),
  declarations("../src/core/listing-image-sources.ts", ["getListingImageSources"]),
  declarations("../src/features/marketplace/listing-screen.tsx", ["ListingGallery"]),
  "module.exports = { ListingGallery };",
].join("\n"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function mountGallery(images, initialIndex, rtl = false) {
  const hooks = [], pending = [], offsets = [], selections = [];
  let cursor = 0, dirty = false, tree, warmed;
  let props = { images, initialIndex, onIndexChange: index => selections.push(index), onClose: () => {} };
  const same = (a, b) => a && b && a.length === b.length && a.every((item, i) => item === b[i]);
  const jsx = (type, props, key) => ({ type, props: props || {}, key });
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: name => { assert.equal(name, "react/jsx-runtime"); return { jsx, jsxs: jsx }; },
    useState: initial => {
      const index = cursor++;
      hooks[index] ||= { value: typeof initial === "function" ? initial() : initial };
      return [hooks[index].value, next => {
        const value = typeof next === "function" ? next(hooks[index].value) : next;
        if (value !== hooks[index].value) { hooks[index].value = value; dirty = true; }
      }];
    },
    useRef: initial => { const index = cursor++; return hooks[index] ||= { current: initial }; },
    useCallback: (callback, deps) => {
      const index = cursor++;
      if (!hooks[index] || !same(hooks[index].deps, deps)) hooks[index] = { value: callback, deps };
      return hooks[index].value;
    },
    useLayoutEffect: (effect, deps) => {
      const index = cursor++, previous = hooks[index];
      if (!previous || !same(previous.deps, deps)) pending.push(() => {
        previous?.cleanup?.(); hooks[index] = { deps, cleanup: effect() };
      });
    },
    useNativeGesture: () => "native-gesture",
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    useStyles: () => ({}), useWarmGalleryPreviews: urls => { warmed = urls; },
    assetUrl: url => url || undefined,
    I18nManager: { isRTL: rtl },
    View: "View", FlatList: "Pager", GestureDetector: "GestureDetector", Pressable: "Pressable",
    ZoomableGalleryImage: "Photo", Icon: "Icon", AppText: "Text",
  });
  const nodes = (type, node = tree) => {
    if (!node) return [];
    if (Array.isArray(node)) return node.flatMap(child => nodes(type, child ?? null));
    if (typeof node !== "object") return [];
    return [...(node.type === type ? [node] : []), ...nodes(type, node.props?.children ?? null)];
  };
  const pager = () => nodes("Pager")[0];
  const render = () => {
    let passes = 0;
    do {
      assert.ok(++passes < 20, "Selection reconciliation must settle");
      dirty = false; cursor = 0;
      tree = module.exports.ListingGallery(props);
      while (pending.length) pending.shift()();
    } while (dirty);
    const list = pager();
    if (list) list.props.ref.current = { scrollToOffset: input => offsets.push(input.offset) };
  };
  const event = callback => { callback(); render(); };
  const layout = (width, height) => event(() => nodes("View").find(node => node.props.onLayout)
    .props.onLayout({ nativeEvent: { layout: { width, height } } }));
  const showPage = index => event(() => pager().props.onViewableItemsChanged({
    viewableItems: [{ isViewable: true, index, item: props.images[index] }],
  }));
  render();
  layout(400, 650);
  return {
    pager, offsets, selections, nodes, event, layout, showPage,
    align: () => event(() => pager().props.onContentSizeChange()),
    updateImages: next => { props = { ...props, images: next }; render(); },
    get warmed() { return warmed; },
  };
}

const images = Array.from({ length: 8 }, (_, i) => ({
  id: `photo-${i + 1}`, originalUrl: `https://images.test/${i + 1}-display.webp`,
  displayUrl: `https://images.test/${i + 1}-display.webp`, thumbnailUrl: `https://images.test/${i + 1}-thumbnail.webp`,
}));

for (const rtl of [false, true]) test(`chosen page remains authoritative in ${rtl ? "RTL" : "LTR"} gallery`, () => {
  const h = mountGallery(images, 3, rtl);
  h.align();
  assert.equal(h.offsets.at(-1), 1200);
  assert.equal(h.pager().props.initialScrollIndex, 3);
  assert.equal(h.pager().props.style.direction, rtl ? "rtl" : "ltr");
  assert.equal(h.pager().props.onMomentumScrollEnd, undefined, "Raw native offset must not overwrite viewability selection");
  h.event(() => h.pager().props.onViewableItemsChanged({ viewableItems: [{ isViewable: true, index: 4, item: images[4] }] }));
  assert.equal(h.selections.at(-1), 4);
  const selected = h.pager().props.renderItem({ item: images[4], index: 4 });
  assert.equal(selected.props.active, true);
  assert.equal(h.pager().props.renderItem({ item: images[3], index: 3 }).props.active, false);
});

for (const rtl of [false, true]) test(`height-only gallery relayout keeps the visible photo active in ${rtl ? "RTL" : "LTR"}`, () => {
  const h = mountGallery(images, 0, rtl);
  h.align();
  const pagerKey = h.pager().key;
  const offsetsBefore = [...h.offsets];

  // Modal/safe-area measurement can settle after the horizontal pager has
  // aligned, without another content-size event. Real page changes must still
  // drive the footer, active image and highest-priority preview.
  h.layout(400, 605);
  assert.equal(h.pager().key, pagerKey);
  h.showPage(1);
  assert.equal(h.selections.at(-1), 1);
  assert.equal(h.pager().props.renderItem({ item: images[1], index: 1 }).props.active, true);
  assert.equal(h.pager().props.renderItem({ item: images[0], index: 0 }).props.active, false);
  assert.ok(h.nodes("Text").some(node => node.props.children === "2 من 8"));
  assert.equal(h.warmed[0], images[1].displayUrl);

  h.layout(400, 590);
  h.showPage(2);
  assert.equal(h.selections.at(-1), 2);
  assert.ok(h.nodes("Text").some(node => node.props.children === "3 من 8"));
  assert.equal(h.warmed[0], images[2].displayUrl);
  assert.deepEqual(h.offsets, offsetsBefore, "Height-only measurements must not reposition the horizontal pager");
});

for (const rtl of [false, true]) test(`an intentional gallery drag takes ownership before late content sizing in ${rtl ? "RTL" : "LTR"}`, () => {
  const h = mountGallery(images, 3, rtl);
  h.showPage(0);
  assert.equal(h.selections.length, 0, "Ignore a transient first-page callback before initial alignment");

  h.event(() => h.pager().props.onScrollBeginDrag());
  h.showPage(4);
  assert.equal(h.selections.at(-1), 4);
  assert.equal(h.pager().props.renderItem({ item: images[4], index: 4 }).props.active, true);
  assert.ok(h.nodes("Text").some(node => node.props.children === "5 من 8"));
  assert.equal(h.warmed[0], images[4].displayUrl);

  h.align();
  assert.equal(h.offsets.length, 0, "A late content-size event cannot pull the user back after a drag");
  h.showPage(5);
  assert.equal(h.selections.at(-1), 5);
});

test("initial matching viewability releases alignment without waiting for a content-size event", () => {
  const h = mountGallery(images, 3);
  h.showPage(3);
  h.showPage(4);
  assert.equal(h.selections.at(-1), 4);
  assert.equal(h.pager().props.renderItem({ item: images[4], index: 4 }).props.active, true);
  h.align();
  assert.equal(h.offsets.length, 0);
});

for (const rtl of [false, true]) test(`width changes still align the selected gallery photo in ${rtl ? "RTL" : "LTR"}`, () => {
  const h = mountGallery(images, 3, rtl);
  h.align();
  h.showPage(4);
  const oldKey = h.pager().key;
  const previousSelections = h.selections.length;

  h.layout(480, 600);
  assert.notEqual(h.pager().key, oldKey);
  assert.equal(h.pager().props.initialScrollIndex, 4);
  h.showPage(0);
  assert.equal(h.selections.length, previousSelections, "A fresh pager must not replace the retained selection with its transient first page");
  h.align();
  assert.equal(h.offsets.at(-1), 480 * 4);
  h.showPage(5);
  assert.equal(h.selections.at(-1), 5);
  assert.equal(h.pager().props.renderItem({ item: images[5], index: 5 }).props.active, true);
  assert.equal(h.warmed[0], images[5].displayUrl);
});

test("open gallery retains photo identity on reorder and safely falls back after removal", () => {
  const h = mountGallery(images, 5);
  h.align();
  const initialKey = h.pager().key;
  h.updateImages([images[5], images[0], images[1]]);
  assert.notEqual(h.pager().key, initialKey);
  assert.equal(h.pager().props.initialScrollIndex, 0);
  h.align();
  assert.equal(h.offsets.at(-1), 0);
  h.updateImages([images[0], images[1]]);
  assert.equal(h.pager().props.initialScrollIndex, 0);
  h.align();
  const before = h.selections.length;
  h.event(() => h.pager().props.onViewableItemsChanged({ viewableItems: [{ isViewable: true, index: 0, item: images[5] }] }));
  assert.equal(h.selections.length, before, "A stale callback from the old list cannot select a removed photo");
});

test("new aliased display derivatives warm while legacy original-only aliases do not", () => {
  const h = mountGallery(images, 3);
  assert.equal(h.warmed[0], images[3].displayUrl);
  assert.equal(h.warmed.length, 8);
  const original = "https://images.test/large-old.jpg";
  h.updateImages([{ id: "legacy", originalUrl: original, displayUrl: original, thumbnailUrl: original }]);
  assert.equal(h.warmed.length, 0);
});
