const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

const filename = path.resolve(__dirname, '../src/features/navigation/scene-blur.tsx');
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
  jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;

function load() {
  const context = { current: null, Provider: 'Provider' };
  const jsx = (type, props) => ({ type, props });
  const imports = {
    react: { createContext: () => context, useContext: value => value.current },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': { View: 'View', StyleSheet: { create: value => value } },
    'expo-blur': { BlurTargetView: 'BlurTarget' },
    '../../ui/theme-context': { useTheme: () => ({ colors: { background: 'current-theme' } }) },
  };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => {
    assert.ok(Object.hasOwn(imports, name), `Unexpected rendering dependency: ${name}`);
    return imports[name];
  } });
  return { ...module.exports, context };
}

test('home fixed controls are outside its single feed blur target without losing their viewport', () => {
  const { NavigationScene, NavigationBlurContent, context } = load();
  const target = { current: null }, content = { header: 'fixed', toolbar: 'floating', feed: 'cards' };
  const scene = NavigationScene({ target, contentTarget: true, children: content });
  assert.equal(scene.props.children.type, 'View');
  assert.equal(scene.props.children.props.style.flex, 1);
  assert.equal(scene.props.children.props.children, content);
  context.current = scene.props.value;
  const feed = NavigationBlurContent({ children: content.feed });
  assert.equal(feed.type, 'BlurTarget');
  assert.equal(feed.props.ref, target, 'The existing bottom navigation target must point to the feed');
  assert.equal(feed.props.style.flex, 1);
  const background = feed.props.children;
  assert.equal(background.type, 'View', 'The blur snapshot records child drawing, so its theme background must be a child');
  assert.equal(background.props.children, content.feed);
  assert.equal(background.props.style[0].flex, 1);
  assert.equal(background.props.style[1].backgroundColor, 'current-theme', 'Transparent feed gaps must keep their theme color in the glass');
});

test('other tabs retain their own whole-scene target and clear the home override', () => {
  const { NavigationScene, NavigationBlurContent, context } = load();
  const home = { current: 'home' }, messages = { current: 'messages' };
  context.current = NavigationScene({ target: home, contentTarget: true, children: 'home' }).props.value;
  const scene = NavigationScene({ target: messages, children: 'messages' });
  assert.equal(scene.props.children.type, 'BlurTarget');
  assert.equal(scene.props.children.props.ref, messages);
  assert.equal(scene.props.children.props.children, 'messages');
  context.current = scene.props.value;
  const nested = NavigationBlurContent({ children: 'other content' });
  assert.equal(nested.type, 'Fragment', 'Another tab must never reuse the home target or add a native viewport');
  assert.equal(nested.props.children, 'other content');
});

test('a screen outside tab navigation keeps its original content without adding a native viewport', () => {
  const { NavigationBlurContent } = load();
  const child = { type: 'feed' };
  const rendered = NavigationBlurContent({ children: child });
  assert.equal(rendered.type, 'Fragment');
  assert.equal(rendered.props.children, child);
  assert.equal(rendered.props.style, undefined);
});
