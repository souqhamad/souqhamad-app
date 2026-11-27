const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const anchorModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, "src/features/conversations/bottom-anchor.ts"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { module: anchorModule, exports: anchorModule.exports });
const { createConversationBottomAnchor } = anchorModule.exports;
const metrics = (y, height = 2300, viewport = 635) => ({
  contentOffset: { y }, contentSize: { height }, layoutMeasurement: { height: viewport },
});

test("layout-generated scroll cannot abandon the initial or newly filled bottom anchor", () => {
  const anchor = createConversationBottomAnchor("thread", () => 1000);
  assert.equal(anchor.measureViewport(635), true);
  assert.equal(anchor.measureContent(2300), true);
  anchor.observe(metrics(1170));
  assert.equal(anchor.shouldFollow(), true);
  assert.equal(anchor.measureContent(2500), true);
  anchor.observe(metrics(1665, 2500));
  assert.equal(anchor.measureViewport(635), true);
});

test("explicit reading position survives new messages and keyboard/window layout", () => {
  const anchor = createConversationBottomAnchor("thread", () => 1000);
  anchor.measureViewport(635);
  anchor.measureContent(2300);
  anchor.beginDrag(metrics(1665));
  anchor.observe(metrics(1000));
  anchor.endDrag(metrics(1000));
  assert.equal(anchor.shouldFollow(), false);
  assert.equal(anchor.measureContent(2500), false);
  assert.equal(anchor.measureViewport(350), false);
  anchor.observe(metrics(1000, 2500, 350));
  assert.equal(anchor.shouldFollow(), false);
});

test("momentum reaches the bottom and re-enables following without false layout input", () => {
  const anchor = createConversationBottomAnchor("thread", () => 1000);
  anchor.measureViewport(635);
  anchor.measureContent(2300);
  anchor.beginDrag(metrics(1000));
  anchor.endDrag(metrics(1250));
  anchor.beginMomentum();
  anchor.observe(metrics(1600));
  anchor.endMomentum(metrics(1665));
  assert.equal(anchor.shouldFollow(), true);
  anchor.observe(metrics(1000, 2300, 350));
  assert.equal(anchor.measureViewport(350), true);
  anchor.observe(metrics(1665, 2500, 350));
  assert.equal(anchor.measureContent(2500), true);
});

test("web wheel/keyboard intent expires and explicit send resumes following", () => {
  let clock = 1000;
  const anchor = createConversationBottomAnchor("thread", () => clock);
  anchor.measureViewport(635);
  anchor.measureContent(2300);
  anchor.noteUserIntent();
  anchor.observe(metrics(1000));
  assert.equal(anchor.shouldFollow(), false);
  clock = 1600;
  anchor.observe(metrics(1665));
  assert.equal(anchor.shouldFollow(), false);
  anchor.followLatest();
  anchor.observe(metrics(1000));
  assert.equal(anchor.measureContent(2600), true);
});

// Extract the actual FlatList callbacks, not a second implementation of them.
// Only list commands and React refs are replaced at this UI boundary.
function screenHandlers() {
  const filename = path.join(root, "src/features/conversations/screens.tsx");
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const callbacks = {};
  function visit(node) {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.tagName.getText(source) === "FlatList" &&
        node.attributes.properties.some(property => property.name?.getText(source) === "data" && property.initializer?.expression?.getText(source) === "messages")) {
      for (const name of ["onScroll", "onLayout", "onContentSizeChange", "onScrollBeginDrag", "onScrollEndDrag", "onMomentumScrollBegin", "onMomentumScrollEnd"]) {
        const attribute = node.attributes.properties.find(property => property.name?.getText(source) === name);
        if (attribute?.initializer?.expression) callbacks[name] = attribute.initializer.expression.getText(source);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  let calls = 0;
  const context = vm.createContext({
    bottomAnchor: createConversationBottomAnchor("thread", () => 1000),
    atBottom: { current: true }, messageViewportHeight: { current: 0 },
    list: { current: { scrollToEnd(options) { assert.equal(options.animated, false); calls++; } } },
  });
  for (const [name, callback] of Object.entries(callbacks)) {
    vm.runInContext(ts.transpileModule(`globalThis.${name} = ${callback}`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText, context);
  }
  return { context, calls: () => calls };
}

test("the actual screen keeps following through the reported mount/content event order", () => {
  const { context, calls } = screenHandlers();
  context.onLayout({ nativeEvent: { layout: { height: 635 } } });
  context.onContentSizeChange(412, 2300);
  assert.equal(calls(), 2);
  context.onScroll({ nativeEvent: metrics(1170) });
  context.onContentSizeChange(412, 2500);
  context.onLayout({ nativeEvent: { layout: { height: 635 } } });
  assert.equal(calls(), 4, "A non-user scroll must not disable subsequent scroll-to-end commands");
});

test("the actual screen preserves a reader's scrollback and follows again at the bottom", () => {
  const { context, calls } = screenHandlers();
  context.onLayout({ nativeEvent: { layout: { height: 635 } } });
  context.onContentSizeChange(412, 2300);
  context.onScrollBeginDrag({ nativeEvent: metrics(1665) });
  context.onScroll({ nativeEvent: metrics(1000) });
  context.onScrollEndDrag({ nativeEvent: metrics(1000) });
  context.onContentSizeChange(412, 2500);
  context.onLayout({ nativeEvent: { layout: { height: 350 } } });
  assert.equal(calls(), 2);
  context.onScrollBeginDrag({ nativeEvent: metrics(1000, 2500, 350) });
  context.onScroll({ nativeEvent: metrics(2150, 2500, 350) });
  context.onScrollEndDrag({ nativeEvent: metrics(2150, 2500, 350) });
  context.onContentSizeChange(412, 2700);
  assert.equal(calls(), 3);
});

test("the actual screen scopes the scroll controller to the account and conversation", () => {
  const source = ts.createSourceFile("screens.tsx", fs.readFileSync(path.join(root, "src/features/conversations/screens.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "bottomAnchor") initializer = node.initializer.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(initializer);
  let previous;
  const context = vm.createContext({
    createConversationBottomAnchor, conversationId: "thread-a", user: { id: "account-a" },
    useMemo(factory, dependencies) {
      if (!previous || dependencies.some((value, index) => value !== previous.dependencies[index])) previous = { dependencies, value: factory() };
      return previous.value;
    },
  });
  const render = () => vm.runInContext(ts.transpileModule(initializer, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  const first = render();
  assert.equal(first.scope, "account-a:thread-a");
  first.measureViewport(635);
  first.measureContent(2300);
  first.beginDrag(metrics(1000));
  first.endDrag(metrics(1000));
  assert.equal(first.shouldFollow(), false);
  assert.equal(render(), first, "The same thread must preserve reading position on re-render");
  context.conversationId = "thread-b";
  const second = render();
  assert.notEqual(second, first);
  assert.equal(second.scope, "account-a:thread-b");
  assert.equal(second.shouldFollow(), true);
  context.user = { id: "account-b" };
  const third = render();
  assert.notEqual(third, second);
  assert.equal(third.scope, "account-b:thread-b");
  assert.equal(third.shouldFollow(), true);
});
