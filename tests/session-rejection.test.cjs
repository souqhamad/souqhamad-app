const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function loadSource(relative, imports, globals = {}) {
  const filename = path.resolve(__dirname, "..", relative);
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, {
    module,
    exports: module.exports,
    require: id => {
      assert.ok(Object.hasOwn(imports, id), `Unexpected dependency ${id}`);
      return imports[id];
    },
    URL, Headers, FormData, AbortController, setTimeout, clearTimeout,
    __DEV__: false,
    process: { env: { EXPO_PUBLIC_API_URL: "https://session-test.invalid" } },
    ...globals,
  }, { filename });
  return module.exports;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function apiHarness(fetch) {
  return loadSource("src/core/api.ts", {
    "expo/fetch": { fetch },
    "expo-file-system": { File: class {} },
    "react-native": { Platform: { OS: "android" } },
  });
}

const denied = () => Response.json({ error: "auth_required" }, { status: 401 });
const flush = () => new Promise(resolve => setImmediate(resolve));

test("current authenticated JSON 401 notifies with the exact request session", async () => {
  const client = apiHarness(async (_url, init) => {
    assert.equal(init.headers.get("authorization"), "Bearer account-a");
    return denied();
  });
  client.setApiIdentity("account-a", "agreement");
  const events = [];
  const unsubscribe = client.subscribeToSessionRejection(session => events.push(session));
  await assert.rejects(client.api.get("/api/marketplace/me/listings"), error => error.code === "auth_required" && error.status === 401);
  assert.equal(events.length, 1);
  assert.equal(events[0].token, "account-a");
  assert.equal(client.isCurrentApiSession(events[0]), true);
  unsubscribe();
  await assert.rejects(client.api.get("/api/marketplace/me/listings"));
  assert.equal(events.length, 1, "unsubscribed providers cannot receive later failures");
});

test("guest 401, non-401 and provider credential failures never reject a session", async () => {
  let response = denied;
  const client = apiHarness(async () => response());
  const events = [];
  client.subscribeToSessionRejection(session => events.push(session));
  await assert.rejects(client.api.get("/api/marketplace/me/listings"));
  client.setApiIdentity("account-a");
  for (const url of ["/api/auth/google/native", "/api/auth/apple/native", "/api/auth/apple/native/challenge"]) {
    await assert.rejects(client.api.post(url));
  }
  for (const [status, error] of [[403, "auth_required"], [500, "auth_required"], [401, "invalid_google_id_token"], [401, "invalid_apple_id_token"]]) {
    response = () => Response.json({ error }, { status });
    await assert.rejects(client.api.get("/api/marketplace/me/listings"));
  }
  assert.equal(events.length, 0);
});

test("a delayed old-account 401 and a token reused in a newer generation cannot expire the current session", async () => {
  const pending = deferred();
  const client = apiHarness(() => pending.promise);
  const events = [];
  client.subscribeToSessionRejection(session => events.push(session));
  client.setApiIdentity("account-a");
  const request = client.api.get("/api/marketplace/me/listings");
  client.setApiIdentity("account-b");
  client.setApiIdentity("account-a");
  pending.resolve(denied());
  await assert.rejects(request, error => error.code === "account_changed");
  assert.equal(events.length, 0);
  assert.equal(client.getSessionToken(), "account-a");
});

test("identity changing while JSON is read also suppresses the old rejection", async () => {
  const body = deferred();
  const client = apiHarness(async () => ({ ok: false, status: 401, text: () => body.promise }));
  const events = [];
  client.subscribeToSessionRejection(session => events.push(session));
  client.setApiIdentity("account-a");
  const request = client.api.get("/api/marketplace/me/listings");
  await flush();
  client.setApiIdentity("account-b");
  body.resolve(JSON.stringify({ error: "auth_required" }));
  await assert.rejects(request, error => error.code === "account_changed");
  assert.equal(events.length, 0);
});

test("raw assistant API rejection is inspected without consuming its response body", async () => {
  const client = apiHarness(async () => denied());
  client.setApiIdentity("account-a");
  const events = [];
  client.subscribeToSessionRejection(session => events.push(session));
  const response = await client.apiFetch("/api/chat", { method: "POST", body: "{}" });
  assert.equal(events.length, 1);
  assert.equal(response.bodyUsed, false);
  assert.deepEqual(await response.json(), { error: "auth_required" });
});

test("raw successful streams are returned intact without cloning or consuming them", async () => {
  const expected = new Response("event: ready\ndata: {}\n\n", { headers: { "Content-Type": "text/event-stream" } });
  const client = apiHarness(async () => expected);
  client.setApiIdentity("account-a");
  const actual = await client.apiFetch("/api/chat", { method: "POST" });
  assert.equal(actual, expected);
  assert.equal(actual.bodyUsed, false);
  assert.equal(await actual.text(), "event: ready\ndata: {}\n\n");
});

test("raw delayed response and delayed cloned JSON cannot reject a newer identity", async () => {
  const pending = deferred();
  const client = apiHarness(() => pending.promise);
  const events = [];
  client.subscribeToSessionRejection(session => events.push(session));
  client.setApiIdentity("account-a");
  const request = client.apiFetch("/api/chat");
  client.setApiIdentity("account-b");
  pending.resolve(denied());
  await assert.rejects(request, error => error.code === "account_changed");
  assert.equal(events.length, 0);

  const body = deferred();
  const next = apiHarness(async () => ({ status: 401, clone: () => ({ json: () => body.promise }) }));
  next.setApiIdentity("account-a");
  next.subscribeToSessionRejection(session => events.push(session));
  const raw = next.apiFetch("/api/chat");
  await flush();
  next.setApiIdentity("account-b");
  body.resolve({ error: "auth_required" });
  await raw;
  assert.equal(events.length, 0);
});

function authHarness(fetch, overrides = {}) {
  const client = apiHarness(fetch);
  client.setApiIdentity("account-a", "agreement");
  const state = overrides.state ?? [{ id: "a", email: "a@example.invalid" }, "authenticated", null];
  const effects = [];
  const deletes = [];
  const writes = [];
  let cursor = 0;
  let clearCount = 0;
  let cancelCount = 0;
  const queryClient = {
    cancelQueries: async () => { cancelCount++; },
    clear: () => { clearCount++; },
    ...overrides.queryClient,
  };
  const react = {
    createContext: () => ({ Provider: "Provider" }),
    useCallback: fn => fn,
    useContext: () => {},
    useRef: value => ({ current: value }),
    useEffect: effect => { effects.push(effect); },
    useState: initial => {
      const index = cursor++;
      if (!(index in state)) state[index] = initial;
      return [state[index], value => { state[index] = typeof value === "function" ? value(state[index]) : value; }];
    },
  };
  const google = {
    configure: () => {},
    hasPlayServices: async () => {},
    signIn: async () => ({ type: "success", data: { idToken: "provider-token" } }),
    ...overrides.google,
  };
  const { AuthProvider } = loadSource("src/core/auth.tsx", {
    react,
    "react/jsx-runtime": { jsx: (_type, props) => props },
    "react-native": { Platform: { OS: "android" } },
    "expo-secure-store": {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
      getItemAsync: overrides.readStorage ?? (async () => null),
      setItemAsync: async (key, value) => { writes.push({ key, value: JSON.parse(value) }); },
      deleteItemAsync: async key => { deletes.push(key); await overrides.deleteStorage?.(key); },
    },
    "expo-apple-authentication": {},
    "expo-crypto": {},
    "expo-constants": { executionEnvironment: "standalone" },
    "@tanstack/react-query": { useQueryClient: () => queryClient },
    "./native-auth": { isGoogleSignInSuccess: response => response?.type === "success" },
    "./session-refresh": loadSource("src/core/session-refresh.ts", {}),
    "./api": client,
    "@react-native-google-signin/google-signin": { GoogleSignin: google },
    "./push": { unregisterNativePushBeforeSignOut: async () => {} },
    "../features/assistant/history": { clearAllAssistantHistory: async () => {} },
  });
  const { value: auth } = AuthProvider({ children: null });
  // Install the real subscription. Storage restoration is a separate lifecycle.
  const cleanup = effects[0]();
  return { client, auth, state, effects, cleanup, deletes, writes,
    get clearCount() { return clearCount; }, get cancelCount() { return cancelCount; } };
}

test("the real AuthProvider clears a rejected session, private cache and secure storage", async () => {
  const harness = authHarness(async () => denied());
  await assert.rejects(harness.client.api.get("/api/marketplace/me/listings"));
  await flush();
  assert.equal(harness.client.getSessionToken(), null);
  assert.equal(harness.client.getAgreementToken(), null);
  assert.equal(harness.state[0], null);
  assert.equal(harness.state[1], "guest");
  assert.equal(harness.clearCount, 1);
  assert.equal(harness.cancelCount, 1);
  assert.equal(harness.deletes.length, 1);
  assert.match(harness.state[2], /انتهت/);
  harness.cleanup();
});

test("a rejected old session during a successful sign-in never clears the new account", async () => {
  const signIn = deferred();
  const harness = authHarness(async url => {
    if (url.endsWith("native-config")) return Response.json({ clientId: "public-client-id" });
    if (url.endsWith("google/native")) return Response.json({ authenticated: true, user: { id: "b", email: "b@example.invalid" }, sessionToken: "account-b" });
    return denied();
  }, { google: { signIn: () => signIn.promise } });
  const login = harness.auth.signInGoogle();
  await flush();
  await assert.rejects(harness.client.api.get("/api/marketplace/me/listings"));
  assert.equal(harness.client.getSessionToken(), "account-a", "rejection waits for the active login operation");
  assert.equal(harness.deletes.length, 0);
  signIn.resolve({ type: "success", data: { idToken: "provider-token" } });
  assert.equal(await login, true);
  await flush();
  assert.equal(harness.client.getSessionToken(), "account-b");
  assert.equal(harness.state[0].id, "b");
  assert.equal(harness.state[1], "authenticated");
  assert.equal(harness.deletes.length, 0);
  assert.equal(harness.writes.at(-1).value.token, "account-b");
  harness.cleanup();
});

test("a deferred rejection is applied when provider sign-in is cancelled", async () => {
  const signIn = deferred();
  const harness = authHarness(async url => url.endsWith("native-config") ? Response.json({ clientId: "public-client-id" }) : denied(), {
    google: { signIn: () => signIn.promise },
  });
  const login = harness.auth.signInGoogle();
  await flush();
  await assert.rejects(harness.client.api.get("/api/marketplace/me/listings"));
  signIn.resolve({ type: "cancelled" });
  assert.equal(await login, false);
  await flush();
  assert.equal(harness.client.getSessionToken(), null);
  assert.equal(harness.state[1], "guest");
  assert.equal(harness.deletes.length, 1);
  harness.cleanup();
});

test("an explicit logout owns cleanup while a parallel request is rejected", async () => {
  const logout = deferred();
  const harness = authHarness(async url => url.endsWith("/logout") ? logout.promise : denied());
  const signingOut = harness.auth.signOut();
  await flush();
  await assert.rejects(harness.client.api.get("/api/marketplace/me/listings"));
  assert.equal(harness.deletes.length, 0);
  logout.resolve(new Response(null, { status: 204 }));
  await signingOut;
  assert.equal(harness.client.getSessionToken(), null);
  assert.equal(harness.state[1], "guest");
  assert.equal(harness.deletes.length, 1);
  harness.cleanup();
});

test("unmount cleanup unsubscribes the actual provider from later session rejections", async () => {
  const harness = authHarness(async () => denied());
  harness.cleanup();
  await assert.rejects(harness.client.api.get("/api/marketplace/me/listings"));
  await flush();
  assert.equal(harness.client.getSessionToken(), "account-a");
  assert.equal(harness.clearCount, 0);
  assert.equal(harness.deletes.length, 0);
});

test("a delayed startup key-store read cannot restore the previous account after login", async () => {
  const restoration = deferred();
  let sessionReads = 0;
  const harness = authHarness(async url => {
    if (url.endsWith("native-config")) return Response.json({ clientId: "public-client-id" });
    if (url.endsWith("google/native")) return Response.json({ authenticated: true, user: { id: "b", email: "b@example.invalid" }, sessionToken: "account-b" });
    sessionReads++;
    return Response.json({ authenticated: true, user: { id: "a", email: "a@example.invalid" } });
  }, { readStorage: () => restoration.promise });
  const stopRestoration = harness.effects[1]();
  assert.equal(await harness.auth.signInGoogle(), true);
  restoration.resolve(JSON.stringify({ token: "account-a", agreement: "old-agreement" }));
  await flush();
  assert.equal(harness.client.getSessionToken(), "account-b");
  assert.equal(harness.state[0].id, "b");
  assert.equal(harness.state[1], "authenticated");
  assert.equal(sessionReads, 0);
  stopRestoration();
  harness.cleanup();
});

test("a delayed startup key-store read cannot restore an account after logout", async () => {
  const restoration = deferred();
  const harness = authHarness(async () => new Response(null, { status: 204 }), {
    readStorage: () => restoration.promise,
  });
  const stopRestoration = harness.effects[1]();
  await harness.auth.signOut();
  restoration.resolve(JSON.stringify({ token: "account-a", agreement: "old-agreement" }));
  await flush();
  assert.equal(harness.client.getSessionToken(), null);
  assert.equal(harness.state[0], null);
  assert.equal(harness.state[1], "guest");
  stopRestoration();
  harness.cleanup();
});

test("corrupt startup storage cleanup is queued before a newer login write", async () => {
  const deletion = deferred();
  const harness = authHarness(async url => {
    if (url.endsWith("native-config")) return Response.json({ clientId: "public-client-id" });
    if (url.endsWith("google/native")) return Response.json({ authenticated: true, user: { id: "b", email: "b@example.invalid" }, sessionToken: "account-b" });
    throw new Error("Stale restoration must not refresh after a login");
  }, { readStorage: async () => "{invalid-json", deleteStorage: () => deletion.promise });
  const stopRestoration = harness.effects[1]();
  await flush();
  assert.equal(harness.deletes.length, 1);
  const login = harness.auth.signInGoogle();
  await flush();
  assert.equal(harness.writes.length, 0, "the session write waits for previous cleanup");
  deletion.resolve();
  assert.equal(await login, true);
  await flush();
  assert.equal(harness.client.getSessionToken(), "account-b");
  assert.equal(harness.writes.at(-1).value.token, "account-b");
  stopRestoration();
  harness.cleanup();
});

test("cold-launch guest initialization and StrictMode effect restart still finish", async () => {
  const firstRead = deferred();
  let reads = 0;
  const harness = authHarness(async () => Response.json({ authenticated: false, user: null }), {
    state: [null, "loading", null],
    readStorage: () => ++reads === 1 ? firstRead.promise : Promise.resolve(null),
  });
  harness.client.setApiIdentity(null, null);
  const firstCleanup = harness.effects[1]();
  firstCleanup();
  const finalCleanup = harness.effects[1]();
  await flush();
  assert.equal(harness.state[1], "guest");
  firstRead.resolve(JSON.stringify({ token: "old-account" }));
  await flush();
  assert.equal(harness.client.getSessionToken(), null);
  assert.equal(harness.state[1], "guest");
  finalCleanup();
  harness.cleanup();
});

test("late refresh cleanup cannot clear a newer login cache or stored token", async () => {
  const cancellation = deferred();
  let cancellations = 0;
  let cacheClears = 0;
  const harness = authHarness(async url => {
    if (url.endsWith("/session")) return Response.json({ authenticated: false, user: null });
    if (url.endsWith("native-config")) return Response.json({ clientId: "public-client-id" });
    if (url.endsWith("google/native")) return Response.json({ authenticated: true, user: { id: "b", email: "b@example.invalid" }, sessionToken: "account-b" });
    throw new Error(`Unexpected request ${url}`);
  }, { queryClient: {
    cancelQueries: () => ++cancellations === 1 ? cancellation.promise : Promise.resolve(),
    clear: () => { cacheClears++; },
  } });
  const refresh = harness.auth.refresh();
  await flush();
  assert.equal(await harness.auth.signInGoogle(), true);
  assert.equal(cacheClears, 1);
  cancellation.resolve();
  await refresh;
  assert.equal(harness.client.getSessionToken(), "account-b");
  assert.equal(harness.state[0].id, "b");
  assert.equal(harness.state[1], "authenticated");
  assert.equal(harness.deletes.length, 0);
  assert.equal(harness.writes.at(-1).value.token, "account-b");
  assert.equal(cacheClears, 1);
  harness.cleanup();
});

test("a foreground refresh waits for cold-launch storage hydration before checking the session", async () => {
  const restoration = deferred();
  let sessionReads = 0;
  const harness = authHarness(async (_url, init) => {
    sessionReads++;
    assert.equal(init.headers.get("authorization"), "Bearer account-a");
    return Response.json({ authenticated: true, user: { id: "a", email: "a@example.invalid" } });
  }, { state: [null, "loading", null], readStorage: () => restoration.promise });
  harness.client.setApiIdentity(null, null);
  const stopRestoration = harness.effects[1]();
  await harness.auth.refresh();
  assert.equal(sessionReads, 0, "an AppState refresh cannot treat an unrestored session as a guest");
  restoration.resolve(JSON.stringify({ token: "account-a", agreement: "agreement" }));
  await flush();
  assert.equal(sessionReads, 1);
  assert.equal(harness.client.getSessionToken(), "account-a");
  assert.equal(harness.state[1], "authenticated");
  assert.equal(harness.deletes.length, 0);
  stopRestoration();
  harness.cleanup();
});

test("the real AuthProvider deduplicates concurrent foreground/account reads without caching them", async () => {
  const response = deferred(); let requests = 0;
  const harness = authHarness(async () => {
    requests++;
    if (requests === 1) await response.promise;
    return Response.json({ authenticated: true, user: { id: "a", email: "a@example.invalid" } });
  });
  const pending = Array.from({ length: 12 }, () => harness.auth.refresh());
  await flush(); assert.equal(requests, 1);
  response.resolve(); await Promise.all(pending);
  await harness.auth.refresh(); assert.equal(requests, 2);
  harness.cleanup();
});

test("a profile-write refresh cannot lose its new account fields behind an earlier session read", async () => {
  const response = deferred(); let requests = 0, name = "old";
  const harness = authHarness(async () => {
    const snapshot = name;
    requests++;
    if (requests === 1) await response.promise;
    return Response.json({ authenticated: true, user: { id: "a", name: snapshot, email: "a@example.invalid" } });
  });
  const first = harness.auth.refresh(); await flush();
  name = "new";
  const written = harness.auth.refresh(true);
  response.resolve(); await Promise.all([first, written]);
  assert.equal(requests, 2);
  assert.equal(harness.state[0].name, "new");
  harness.cleanup();
});

test("a session response started before a profile-picture write cannot restore the stale picture", async () => {
  const response = deferred();
  const original = { id: "a", email: "a@example.invalid", picture: "https://images.invalid/old.webp" };
  const harness = authHarness(async url => {
    assert.match(url, /\/api\/auth\/session$/);
    return response.promise;
  }, { state: [original, "authenticated", null] });
  const refresh = harness.auth.refresh();
  await flush();
  harness.auth.applyProfileUser({ ...original, picture: "https://images.invalid/new.webp" }, harness.client.getApiIdentity());
  response.resolve(Response.json({
    authenticated: true,
    user: original,
  }));
  await refresh;
  assert.equal(harness.state[0].picture, "https://images.invalid/new.webp");
  harness.cleanup();
});

test("a successful queued profile save protects its name and picture from an older session read", async () => {
  const session = deferred();
  const original = { id: "a", email: "a@example.invalid", name: "old", picture: "https://images.invalid/old.webp" };
  const canonical = { ...original, name: "new", phoneNumber: "0555555555", picture: "https://images.invalid/new.webp" };
  const harness = authHarness(async url => {
    if (url.endsWith("/session")) return session.promise;
    assert.match(url, /\/api\/account\/profile$/);
    return Response.json({ user: canonical });
  }, { state: [original, "authenticated", null] });
  const refresh = harness.auth.refresh();
  await flush();
  const identity = harness.client.getApiIdentity();
  await harness.auth.runProfileWrite(identity, async assertCurrent => {
    const result = await harness.client.api.patch("/api/account/profile", {}, { expectedIdentity: identity });
    assertCurrent();
    harness.auth.applyProfileUser(result.user, identity);
  });
  const immediate = JSON.parse(JSON.stringify(harness.state[0]));
  session.resolve(Response.json({ authenticated: true, user: original }));
  await refresh;
  assert.deepEqual(immediate, canonical, "the server response is applied before any session read finishes");
  assert.deepEqual(JSON.parse(JSON.stringify(harness.state[0])), canonical);
  harness.cleanup();
});

test("an older failed session read cannot attach an obsolete error after a successful profile write", async () => {
  const session = deferred();
  const harness = authHarness(() => session.promise);
  const refresh = harness.auth.refresh();
  await flush();
  const identity = harness.client.getApiIdentity();
  await harness.auth.runProfileWrite(identity, async assertCurrent => {
    assertCurrent();
    harness.auth.applyProfileUser({ id: "a", email: "a@example.invalid", name: "new" }, identity);
  });
  session.resolve(Response.json({ error: "temporary_error" }, { status: 500 }));
  await refresh;
  assert.equal(harness.state[0].name, "new");
  assert.equal(harness.state[1], "authenticated");
  assert.equal(harness.state[2], null);
  harness.cleanup();
});

test("the provider rejects queued profile work as soon as logout starts before clearing its bearer", async () => {
  const gate = deferred();
  const started = deferred();
  const logout = deferred();
  const harness = authHarness(async url => {
    assert.match(url, /\/logout$/);
    return logout.promise;
  });
  const identity = harness.client.getApiIdentity();
  let queuedRan = false;
  const active = assert.rejects(harness.auth.runProfileWrite(identity, async assertCurrent => {
    started.resolve();
    await gate.promise;
    assertCurrent();
  }), error => error.code === "account_changed");
  await started.promise;
  const queued = assert.rejects(harness.auth.runProfileWrite(identity, async () => {
    queuedRan = true;
  }), error => error.code === "account_changed");
  const signingOut = harness.auth.signOut();
  await flush();
  assert.equal(harness.client.getSessionToken(), "account-a");
  gate.resolve();
  await Promise.all([active, queued]);
  assert.equal(queuedRan, false);
  logout.resolve(new Response(null, { status: 204 }));
  await signingOut;
  harness.cleanup();
});

test("rejected old identity work cannot displace the current account's active profile queue", async () => {
  const gate = deferred();
  const started = deferred();
  const harness = authHarness(async () => { throw new Error("No network request expected"); });
  const oldIdentity = harness.client.getApiIdentity();
  harness.client.setApiIdentity("account-b");
  const identity = harness.client.getApiIdentity();
  const order = [];
  const first = harness.auth.runProfileWrite(identity, async () => {
    order.push("first");
    started.resolve();
    await gate.promise;
  });
  await started.promise;
  await assert.rejects(harness.auth.runProfileWrite(oldIdentity, async () => {
    throw new Error("An obsolete write must never run");
  }), error => error.code === "account_changed");
  const second = harness.auth.runProfileWrite(identity, async () => { order.push("second"); });
  await flush();
  assert.deepEqual(order, ["first"]);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first", "second"]);
  harness.cleanup();
});
