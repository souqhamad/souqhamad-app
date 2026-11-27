const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Run the actual screen and event handlers; native controls remain the boundary.
function screenHarness(options = {}) {
  const slots = [];
  const pendingEffects = [];
  const events = [];
  const platform = options.platform ?? "ios";
  let cursor = 0;
  let tree;
  let availabilityCalls = 0;
  const auth = {
    user: null, status: "guest",
    acceptAgreement: async () => { events.push("agreement"); await options.acceptAgreement?.(); },
    signInApple: async () => { events.push("apple"); await options.signInApple?.(); },
    signInGoogle: async () => { events.push("google"); return options.signInGoogle ? options.signInGoogle() : true; },
  };
  const bootstrap = { data: { auth: { google: true, apple: true, ...options.providers } }, isError: false };
  const feedback = { success: () => events.push("success") };
  const element = (type, props) => ({ type, props: props ?? {} });
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) {
        pendingEffects.push(() => {
          previous?.cleanup?.();
          slots[index] = { dependencies, cleanup: effect() };
        });
      }
    },
  };
  const imports = {
    react,
    "react/jsx-runtime": { jsx: element, jsxs: element },
    "react-native": { Platform: { OS: platform }, Pressable: "Pressable", View: "View", ActivityIndicator: "ActivityIndicator", StyleSheet: { create: value => value } },
    "expo-router": { router: { canGoBack: () => false, replace: value => events.push(`route:${value}`), push: value => events.push(`push:${value}`) } },
    "expo-apple-authentication": {
      AppleAuthenticationButton: "AppleAuthenticationButton",
      AppleAuthenticationButtonType: { CONTINUE: "continue" },
      AppleAuthenticationButtonStyle: { WHITE: "white", BLACK: "black" },
      isAvailableAsync: async () => { availabilityCalls++; return options.availability ? options.availability() : true; },
    },
    "expo-linear-gradient": { LinearGradient: "LinearGradient" },
    "expo-constants": { expoConfig: { android: { package: "com.souqhamad.app" } } },
    "../core/auth": { useAuth: () => auth },
    "../core/bootstrap": { useBootstrap: () => bootstrap },
    "../core/native-auth": { googleSignInErrorMessage: error => error.message },
    "../core/errors": { userMessage: (error, fallback) => error.message || fallback },
    "../ui/feedback": { useFeedback: () => feedback },
    "../ui": {
      AppText: "AppText", Button: "Button", Card: "Card", Icon: "Icon", PageHeader: "PageHeader", Screen: "Screen",
      useTheme: () => ({ colors: {}, scheme: options.scheme ?? "light" }),
      createThemedStyles: create => { const styles = create({}); return () => styles; },
    },
  };
  const filename = path.resolve(__dirname, "../src/app/auth.tsx");
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, {
    module, exports: module.exports, Error,
    require: name => { assert.ok(Object.hasOwn(imports, name), `Unexpected screen dependency ${name}`); return imports[name]; },
  }, { filename });
  function allNodes() {
    const result = [];
    function visit(value) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") { result.push(value); visit(value.props?.children); }
    }
    visit(tree);
    return result;
  }
  function render() {
    cursor = 0;
    tree = module.exports.default();
    pendingEffects.splice(0).forEach(effect => effect());
    return tree;
  }
  function textContent() {
    return allNodes().flatMap(node => [node.props?.children].flat(Infinity)).filter(value => typeof value === "string").join(" ");
  }
  render();
  return {
    render, auth, bootstrap, events, textContent,
    find: type => allNodes().find(node => node.type === type),
    google: () => allNodes().find(node => node.type === "Button" && node.props.icon === "logo-google"),
    accept: () => { allNodes().find(node => node.props.accessibilityRole === "checkbox").props.onPress(); render(); },
    get availabilityCalls() { return availabilityCalls; },
  };
}

test("Apple's native localized control waits for device availability and follows the appearance", async () => {
  const available = deferred();
  const screen = screenHarness({ availability: () => available.promise, scheme: "dark" });
  assert.equal(screen.find("AppleAuthenticationButton"), undefined);
  available.resolve(true);
  await flush();
  screen.render();
  const button = screen.find("AppleAuthenticationButton");
  assert.equal(button.props.buttonType, "continue");
  assert.equal(button.props.buttonStyle, "white");
  assert.equal(button.props.style.height, 44);
  assert.equal(button.props.style.width, "100%");
  assert.equal(button.props.pointerEvents, "auto");
});

test("server-disabled Apple never starts agreement or authentication even through its callback", async () => {
  const screen = screenHarness({ providers: { apple: false } });
  await flush();
  screen.accept();
  const button = screen.find("AppleAuthenticationButton");
  assert.equal(button.props.pointerEvents, "none");
  assert.equal(button.props.accessibilityState.disabled, true);
  button.props.onPress();
  await flush();
  assert.deepEqual(screen.events, []);
  assert.match(screen.textContent(), /Apple غير متاح حاليًا/);
});

test("Apple requires the same terms and 1% acknowledgement before starting sign-in", async () => {
  const screen = screenHarness();
  await flush();
  screen.render();
  screen.find("AppleAuthenticationButton").props.onPress();
  screen.render();
  assert.deepEqual(screen.events, []);
  assert.match(screen.textContent(), /قبل تسجيل الدخول/);
  assert.match(screen.textContent(), /1%/);
});

test("Apple acknowledges once before sign-in, blocks duplicate presses, and navigates only after the account is ready", async () => {
  const signIn = deferred();
  const screen = screenHarness({ signInApple: () => signIn.promise });
  await flush();
  screen.accept();
  const staleApple = screen.find("AppleAuthenticationButton");
  assert.equal(screen.google(), undefined);
  staleApple.props.onPress();
  staleApple.props.onPress();
  await flush();
  screen.render();
  assert.deepEqual(screen.events, ["agreement", "apple"]);
  assert.equal(screen.google(), undefined);
  assert.equal(screen.find("AppleAuthenticationButton").props.accessibilityState.busy, true);
  assert.equal(screen.find("AppleAuthenticationButton").props.pointerEvents, "none");
  assert.ok(screen.find("ActivityIndicator"));
  signIn.resolve();
  await flush();
  screen.render();
  assert.deepEqual(screen.events, ["agreement", "apple"]);
  screen.auth.status = "authenticated";
  screen.auth.user = { id: "apple-account", name: "Hamad" };
  screen.render();
  assert.deepEqual(screen.events, ["agreement", "apple", "success", "route:/"]);
});

test("Apple cancellation returns to an idle screen and agreement failures cannot start the provider", async () => {
  for (const stage of ["agreement", "apple"]) {
    const failure = stage === "apple" ? Object.assign(new Error("cancelled"), { code: "ERR_REQUEST_CANCELED" }) : new Error("agreement failed");
    const screen = screenHarness({
      acceptAgreement: async () => { if (stage === "agreement") throw failure; },
      signInApple: async () => { if (stage === "apple") throw failure; },
    });
    await flush();
    screen.accept();
    screen.find("AppleAuthenticationButton").props.onPress();
    await flush();
    screen.render();
    assert.deepEqual(screen.events, stage === "apple" ? ["agreement", "apple"] : ["agreement"]);
    assert.equal(screen.find("AppleAuthenticationButton").props.accessibilityState.busy, false);
    assert.equal(screen.find("AppleAuthenticationButton").props.pointerEvents, "auto");
    assert.equal(screen.textContent().includes("cancelled"), false);
    if (stage === "agreement") assert.match(screen.textContent(), /agreement failed/);
  }
});

test("unavailable Apple devices do not render its native control, including availability-check failure", async () => {
  for (const availability of [async () => false, async () => { throw new Error("unavailable"); }]) {
    const screen = screenHarness({ availability });
    await flush();
    screen.render();
    assert.equal(screen.find("AppleAuthenticationButton"), undefined);
    assert.match(screen.textContent(), /غير متاح على هذا الجهاز/);
    assert.equal(screen.google(), undefined);
  }
});

test("iOS does not offer Google or show Google setup errors regardless of server flags", async () => {
  for (const google of [true, false]) {
    const screen = screenHarness({ providers: { google, apple: false } });
    await flush();
    screen.render();
    assert.equal(screen.google(), undefined);
    assert.equal(screen.textContent().includes("Google"), false);
  }
});

test("Android keeps Google sign-in, its cancellation behavior and policy links without Apple checks", async () => {
  const screen = screenHarness({ platform: "android", signInGoogle: async () => false });
  await flush();
  screen.accept();
  assert.equal(screen.availabilityCalls, 0);
  assert.equal(screen.find("AppleAuthenticationButton"), undefined);
  screen.google().props.onPress();
  await flush();
  screen.render();
  assert.deepEqual(screen.events, ["agreement", "google"]);
  screen.auth.status = "authenticated";
  screen.auth.user = { id: "later-account" };
  screen.render();
  assert.deepEqual(screen.events, ["agreement", "google"], "cancelled Google must not navigate on a later session update");
});
