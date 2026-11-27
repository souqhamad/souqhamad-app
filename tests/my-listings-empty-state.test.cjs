const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const filename = path.resolve(__dirname, "../src/app/(tabs)/listings.tsx");
const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  fileName: filename,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

// Execute the actual screen and its callbacks, with native hosts and providers replaced.
function harness({ guest = false } = {}) {
  const slots = [], events = [];
  let cursor = 0;
  const query = {
    data: { pages: [{ listings: [] }], pageParams: [1] },
    isPending: false, isError: false, isFetching: false, hasNextPage: false,
    refetch: () => { events.push("refetch"); },
    fetchNextPage: async () => { events.push("next-page"); return { isFetchNextPageError: false }; },
  };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const controls = Object.fromEntries(["ActionMenu", "Button", "Chip", "EmptyState", "InlineNotice", "ListingCard", "LoadingState", "PageHeader", "Screen"].map(name => [name, name]));
  const imports = {
    react: {
      useState(initial) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = initial;
        return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
      },
      useRef: current => ({ current }), useEffect: () => {},
      useMemo: create => create(), useCallback: callback => callback,
    },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { FlatList: "FlatList", RefreshControl: "RefreshControl", ScrollView: "ScrollView", View: "View", StyleSheet: { create: value => value } },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ bottom: 0 }) },
    "expo-router": { router: { push: route => events.push(route) } },
    "expo-crypto": {},
    "../../ui/action-mutation": { useActionMutation: () => ({}) },
    "../../ui/feedback": { SystemAlert: {}, useFeedback: () => ({}) },
    "../../ui/theme-context": { useTheme: () => ({ colors: {} }) },
    "../../core/visible-query": { useVisibleInfiniteQuery: () => query },
    "../../core/api": { api: {} },
    "../../core/auth": { useAuth: () => ({ user: guest ? null : { id: "owner" }, status: guest ? "guest" : "authenticated" }) },
    "../../core/listing-publication-context": { useListingPublication: () => ({ coordinator: {}, jobs: [] }) },
    "../../core/listing-publication-fields": require("../src/core/listing-publication-fields.ts"),
    "../../core/errors": { userMessage: (error, fallback) => error?.message || fallback },
    "../../core/pagination": { uniqueListings: pages => pages.flatMap(page => page.listings) },
    "../../ui": controls,
  };
  const module = { exports: {} };
  vm.runInNewContext(javascript, {
    module, exports: module.exports,
    require: name => { assert.ok(Object.hasOwn(imports, name), `Unexpected screen dependency ${name}`); return imports[name]; },
  }, { filename });
  function render() { cursor = 0; return module.exports.default(); }
  return { render, query, events };
}

function nodes(node, type) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(child => nodes(child, type));
  const childProps = ["children", "right", "action", "ListEmptyComponent", "ListHeaderComponent", "ListFooterComponent"];
  return [...(node.type === type ? [node] : []), ...childProps.flatMap(key => nodes(node.props?.[key], type))];
}
const buttons = (tree, title) => nodes(tree, "Button").filter(node => node.props.title === title);

test("empty my listings keeps a single create entry in the page header", () => {
  const h = harness(), tree = h.render();
  const empty = nodes(tree, "EmptyState")[0];
  assert.equal(empty.props.title, "لا توجد إعلانات");
  assert.equal(empty.props.action, undefined);
  assert.equal(buttons(tree, "إنشاء إعلان").length, 1);
  const create = nodes(tree, "PageHeader")[0].props.right;
  assert.equal(create.props.title, "إنشاء إعلان");
  create.props.onPress();
  assert.deepEqual(h.events, ["/create"]);
});

test("a filtered empty list still resets to all without adding a second create button", () => {
  const h = harness();
  nodes(h.render(), "Chip").find(node => node.props.label === "المنشورة").props.onPress();
  const filtered = h.render();
  assert.equal(nodes(filtered, "EmptyState")[0].props.title, "لا توجد إعلانات بهذه الحالة");
  assert.equal(buttons(filtered, "إنشاء إعلان").length, 1);
  buttons(filtered, "عرض الكل")[0].props.onPress();
  const all = h.render();
  assert.equal(nodes(all, "Chip").find(node => node.props.label === "الكل").props.active, true);
  assert.equal(buttons(all, "عرض الكل").length, 0);
  assert.equal(nodes(all, "EmptyState")[0].props.action, undefined);
});

test("load errors retain their retry action and the existing next-page retry path", () => {
  const h = harness();
  Object.assign(h.query, { isError: true, error: new Error("offline") });
  const failed = h.render();
  assert.equal(nodes(failed, "EmptyState")[0].props.title, "تعذّر تحميل إعلاناتك");
  assert.equal(buttons(failed, "إنشاء إعلان").length, 1);
  buttons(failed, "إعادة المحاولة")[0].props.onPress();
  assert.deepEqual(h.events, ["refetch"]);
  h.query.isFetchNextPageError = true;
  buttons(h.render(), "إعادة المحاولة")[0].props.onPress();
  assert.deepEqual(h.events, ["refetch", "next-page"]);
});

test("guests retain the login action for my listings", () => {
  const h = harness({ guest: true }), tree = h.render();
  assert.equal(buttons(tree, "إنشاء إعلان").length, 0);
  buttons(tree, "تسجيل الدخول")[0].props.onPress();
  assert.deepEqual(h.events, ["/auth"]);
});
