const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function harness(overrides = {}) {
  let owner = "owner-a";
  let permission = { granted: true, canAskAgain: true };
  const storage = new Map();
  const calls = [];
  const effects = [];
  const layoutCleanups = [];
  const responseListeners = new Set();
  const navigation = [];
  const state = { tokenRequests: 0, permissionRequests: 0, notificationHandler: null, lastResponse: null };
  class ApiError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  }
  const notifications = {
    AndroidImportance: { HIGH: 4 },
    setNotificationHandler: handler => { state.notificationHandler = handler; },
    setNotificationChannelAsync: async () => {},
    getPermissionsAsync: async () => permission,
    requestPermissionsAsync: async () => { state.permissionRequests++; return permission; },
    getDevicePushTokenAsync: async () => { state.tokenRequests++; return { type: "android", data: "fixture-device-token-value" }; },
    unregisterForNotificationsAsync: async () => {},
    dismissAllNotificationsAsync: async () => {},
    setBadgeCountAsync: async () => {},
    addPushTokenListener: () => ({ remove() {} }),
    addNotificationResponseReceivedListener: listener => { responseListeners.add(listener); return { remove() { responseListeners.delete(listener); } }; },
    getLastNotificationResponseAsync: async () => state.lastResponse,
    clearLastNotificationResponseAsync: async () => { state.lastResponse = null; },
    ...overrides.notifications,
  };
  const exports = {};
  const filename = path.resolve(__dirname, "../src/core/push.ts");
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(javascript, {
    exports, module: { exports }, AbortSignal, console,
    require: id => {
      if (id === "react") return {
        useEffect: effect => effects.push(effect),
        useLayoutEffect: effect => {
          const cleanup = effect();
          if (typeof cleanup === "function") layoutCleanups.push(cleanup);
        },
      };
      if (id === "react-native") return { AppState: { addEventListener: () => ({ remove() {} }) }, Platform: { OS: "android" } };
      if (id === "expo-device") return { isDevice: true };
      if (id === "expo-constants") return { executionEnvironment: "standalone", expoConfig: { version: "fixture", extra: { androidPushConfigured: overrides.configured ?? true } } };
      if (id === "expo-notifications") return notifications;
      if (id === "expo-secure-store") return {
        WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
        getItemAsync: async key => {
          if (overrides.storageReadFailure?.(key)) throw new Error("secure storage unavailable");
          return storage.get(key) ?? null;
        },
        setItemAsync: async (key, value) => { storage.set(key, value); },
        deleteItemAsync: async key => { storage.delete(key); },
      };
      if (id === "expo-router") return { router: { push: destination => navigation.push(destination) } };
      if (id === "expo/fetch") return { fetch: async (url, init) => {
        calls.push({ url, ...init, body: JSON.parse(init.body) });
        const response = overrides.fetch ? await overrides.fetch(url, init) : { ok: true, status: 200 };
        return { ...response, json: response.json ?? (async () => ({})) };
      } };
      if (id === "./api") return { ApiError, getSessionToken: () => owner, getApiBaseUrl: () => "https://souqhamad.com" };
      if (id === "./errors") return { userMessage: (_error, fallback) => fallback };
      if (id === "./notification-destination") return { notificationDestination: value => typeof value === "string" ? value : null };
      throw new Error(`Unexpected import: ${id}`);
    },
  }, { filename });
  return { api: exports, calls, storage, state, effects, layoutCleanups, responseListeners, navigation,
    setOwner: value => { owner = value; }, setPermission: value => { permission = value; } };
}

test("notification switch is enabled only after the native device token is registered for the current account", async () => {
  const h = harness();
  assert.equal((await h.api.getNativePushState()).status, "disabled");
  await h.api.enableNativePush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "https://souqhamad.com/api/mobile/push/register");
  assert.equal(h.calls[0].headers.Authorization, "Bearer owner-a");
  assert.equal(h.calls[0].body.token, "fixture-device-token-value");
  assert.equal((await h.api.getNativePushState()).status, "enabled");
  h.setOwner("owner-b");
  assert.equal((await h.api.getNativePushState()).status, "disabled");
});

test("refusing notification permission never requests or registers a token", async () => {
  const h = harness();
  h.setPermission({ granted: false, canAskAgain: false });
  assert.equal((await h.api.getNativePushState()).status, "denied");
  await assert.rejects(h.api.enableNativePush(), error => error.code === "push_permission_denied");
  assert.equal(h.state.tokenRequests, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.storage.has("hamad.native-push.enabled"), false);
});

test("account changes while the native token is loading cannot register the device to either account", async () => {
  const token = deferred();
  const requested = deferred();
  const h = harness({ notifications: { getDevicePushTokenAsync: async () => { requested.resolve(); return token.promise; } } });
  const pending = h.api.enableNativePush();
  await requested.promise;
  h.setOwner("owner-b");
  token.resolve({ type: "android", data: "fixture-device-token-value" });
  await assert.rejects(pending, error => error.code === "account_changed");
  assert.equal(h.calls.length, 0);
  assert.equal(h.storage.has("hamad.native-push.enabled"), false);
});

test("a registration completing after an account switch is removed using its original owner", async () => {
  const posted = deferred(), response = deferred();
  const h = harness({ fetch: async (_url, init) => {
    if (init.method === "POST") { posted.resolve(); return response.promise; }
    return { ok: true, status: 200 };
  } });
  const pending = h.api.enableNativePush();
  await posted.promise;
  h.setOwner("owner-b");
  response.resolve({ ok: true, status: 200 });
  await assert.rejects(pending, error => error.code === "account_changed");
  assert.deepEqual(h.calls.map(call => [call.method, call.headers.Authorization]), [["POST", "Bearer owner-a"], ["DELETE", "Bearer owner-a"]]);
  assert.equal(h.storage.has("hamad.native-push.enabled"), false);
});

test("missing native configuration and failed server registration never claim notifications are enabled", async () => {
  const absent = harness({ configured: false });
  assert.equal((await absent.api.getNativePushState()).status, "unavailable");
  await assert.rejects(absent.api.enableNativePush(), error => error.code === "push_not_configured");
  assert.equal(absent.state.tokenRequests, 0);
  const rejected = harness({ fetch: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(rejected.api.enableNativePush(), error => error.code === "push_registration_failed");
  assert.equal((await rejected.api.getNativePushState()).status, "disabled");
});

test("expired-session cleanup uses its scoped removal capability without the rejected bearer", async () => {
  const h = harness({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ removalToken: "scoped-removal-proof" }) }) });
  await h.api.enableNativePush();
  h.setOwner(null);
  await h.api.unregisterNativePushBeforeSignOut();
  const request = h.calls.at(-1);
  assert.equal(request.method, "DELETE");
  assert.equal(request.headers.Authorization, undefined);
  assert.equal(request.credentials, "omit");
  assert.equal(request.body.removalToken, "scoped-removal-proof");
  assert.equal(h.storage.has("hamad.native-push.pending-removal"), false);
});

test("unmounting an expired account never cancels device removal", async () => {
  let dismissed = 0;
  const h = harness({
    notifications: { dismissAllNotificationsAsync: async () => { dismissed++; } },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ removalToken: "old-registration-only" }) }),
  });
  await h.api.enableNativePush();
  h.storage.delete("hamad.native-push.enabled");
  h.api.useNativePushLifecycle("user-a");
  const unmount = h.effects.at(-1)();
  const cleanup = h.api.unregisterNativePushBeforeSignOut("owner-a");
  h.setOwner(null);
  unmount();
  await cleanup;
  assert.equal(h.calls.at(-1).method, "DELETE");
  assert.equal(h.calls.at(-1).body.removalToken, "old-registration-only");
  assert.equal(dismissed, 1);
  assert.equal(h.storage.has("hamad.native-push.registration"), false);
});

test("a new account registration waits for old removal and survives its completion", async () => {
  const removing = deferred(), removed = deferred();
  let unregistered = 0;
  const h = harness({
    notifications: { unregisterForNotificationsAsync: async () => { unregistered++; } },
    fetch: async (_url, init) => {
      if (init.method === "DELETE") { removing.resolve(); await removed.promise; }
      return { ok: true, status: 200, json: async () => ({ removalToken: "scoped:" + init.headers.Authorization }) };
    },
  });
  await h.api.enableNativePush();
  const cleanup = h.api.unregisterNativePushBeforeSignOut("owner-a");
  await removing.promise;
  h.setOwner("owner-b");
  const enabling = h.api.enableNativePush();
  removed.resolve();
  await Promise.all([cleanup, enabling]);
  assert.equal((await h.api.getNativePushState()).status, "enabled");
  assert.equal(JSON.parse(h.storage.get("hamad.native-push.registration")).bearer, "owner-b");
  assert.equal(unregistered, 0);
  assert.deepEqual(h.calls.map(call => call.method), ["POST", "DELETE", "POST"]);
});

test("secure storage failure still clears local notifications on session expiry", async () => {
  let fail = false, dismissed = 0;
  const h = harness({ storageReadFailure: () => fail,
    notifications: { dismissAllNotificationsAsync: async () => { dismissed++; } } });
  await h.api.enableNativePush();
  fail = true;
  h.setOwner(null);
  await assert.rejects(h.api.unregisterNativePushBeforeSignOut("owner-a"), /secure storage unavailable/);
  assert.equal(dismissed, 1);
});

test("failed capability removal remains queued for retry while local notifications are disabled", async () => {
  let fail = true, dismissed = 0;
  const h = harness({ notifications: { dismissAllNotificationsAsync: async () => { dismissed++; } }, fetch: async (_url, init) => {
    if (init.method === "DELETE" && fail) return { ok: false, status: 503 };
    return { ok: true, status: 200, json: async () => ({ removalToken: "scoped-proof" }) };
  } });
  await h.api.enableNativePush();
  await assert.rejects(h.api.unregisterNativePushBeforeSignOut());
  assert.ok(h.storage.has("hamad.native-push.pending-removal"));
  assert.equal(dismissed, 1);
  fail = false;
  await h.api.unregisterNativePushBeforeSignOut();
  assert.equal(h.storage.has("hamad.native-push.pending-removal"), false);
});

test("a notification for the previous account is neither shown nor opened after an account switch", async () => {
  const h = harness();
  h.api.useNativePushLifecycle("user-a");
  const currentAccountNotification = { request: { content: { data: { recipientId: "user-a", url: "/conversations/a" } } } };
  const oldAccountNotification = { request: { content: { data: { recipientId: "user-a", url: "/conversations/a" } } } };

  assert.equal((await h.state.notificationHandler.handleNotification(currentAccountNotification)).shouldShowBanner, true);
  h.setOwner("owner-b");
  assert.equal((await h.state.notificationHandler.handleNotification(oldAccountNotification)).shouldShowBanner, false);
  for (const listener of h.responseListeners) listener({ notification: oldAccountNotification });
  assert.deepEqual(h.navigation, []);

  h.layoutCleanups.forEach(cleanup => cleanup());
});

test("notifications queued before recipient isolation are ignored", async () => {
  const h = harness();
  h.api.useNativePushLifecycle("user-a");
  const legacy = { request: { content: { data: { url: "/conversations/a" } } } };
  assert.equal((await h.state.notificationHandler.handleNotification(legacy)).shouldShowBanner, false);
  for (const listener of h.responseListeners) listener({ notification: legacy });
  assert.deepEqual(h.navigation, []);
  h.layoutCleanups.forEach(cleanup => cleanup());
});
