const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

// Execute the screen's actual mutation, keeping native media and network calls
// isolated. A copied upload implementation could hide an unguarded screen await.
const filename = path.resolve(__dirname, "../src/features/account/screens.tsx");
const source = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const mutations = {};
function visit(node) {
  if (ts.isVariableDeclaration(node) && ["picture", "removePicture", "save"].includes(node.name.getText(source)) &&
      ts.isCallExpression(node.initializer)) {
    mutations[node.name.getText(source)] = node.initializer.arguments[0].properties.find(property =>
      property.name?.getText(source) === "mutationFn").initializer;
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(mutations.picture, "The account screen must expose its picture mutation");
assert.ok(mutations.removePicture, "The account screen must expose its picture removal mutation");
assert.ok(mutations.save, "The account screen must expose its profile save mutation");
const authFilename = path.resolve(__dirname, "../src/core/auth.tsx");
const authSource = ts.createSourceFile(authFilename, fs.readFileSync(authFilename, "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let profileWriteQueue;
function findQueue(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(authSource) === "runProfileWrite")
    profileWriteQueue = node.initializer;
  ts.forEachChild(node, findQueue);
}
findQueue(authSource);
assert.ok(profileWriteQueue, "Profile writes must share the provider's queue across editors");
const queueJavascript = ts.transpileModule(`module.exports = ${profileWriteQueue.getText(authSource)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const javascript = ts.transpileModule(`module.exports = { ${Object.entries(mutations)
  .map(([name, mutation]) => `${name}: ${mutation.getText(source)}`).join(", ")} };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(options = {}) {
  let identity = { token: "account-a", generation: 1 };
  const epoch = { current: 0 };
  const operation = { current: null };
  const calls = [];
  const uploads = [];
  const gates = Object.fromEntries(["picker", "render", "save", "upload", "delete", "patch"].map(stage => [stage, deferred()]));
  const reached = Object.fromEntries(Object.keys(gates).map(stage => [stage, deferred()]));
  const profileUser = { id: "a", email: "a@example.invalid", picture: "https://images.invalid/profile-new.webp" };
  let serverUser = { ...profileUser, picture: "https://images.invalid/profile-old.webp" };
  let currentUser = serverUser;
  const appliedProfiles = [];
  async function stage(name, value) {
    calls.push(name);
    reached[name].resolve();
    if (options.pause === name) await gates[name].promise;
    if (options.fail === name) throw new Error(`${name} failed`);
    return value;
  }
  const rendered = {
    saveAsync: settings => { calls.push({ saveSettings: settings }); return stage("save", { uri: "fixture://rendered-account-a" }); },
    release: () => calls.push("release-rendered"),
  };
  const context = {
    resize: settings => { calls.push({ resize: settings }); if (options.fail === "resize") throw new Error("resize failed"); },
    renderAsync: () => stage("render", rendered),
    release: () => calls.push("release-context"),
  };
  const assertApiIdentity = expected => {
    if (expected.token !== identity.token || expected.generation !== identity.generation) {
      const error = new Error("account changed");
      error.status = 409;
      error.code = "account_changed";
      throw error;
    }
  };
  const queueModule = { exports: undefined };
  vm.runInNewContext(queueJavascript, {
    module: queueModule,
    useCallback: callback => callback,
    epoch, operation, restoring: { current: false }, profileWriteQueue: { current: null },
    assertApiIdentity,
    ApiError: class extends Error {
      constructor(status, code, message) { super(message); this.status = status; this.code = code; }
    },
  }, { filename: authFilename });
  const globals = {
    ImagePicker: { launchImageLibraryAsync: settings => {
      calls.push({ pickerSettings: settings });
      return stage("picker", options.canceled ? { canceled: true, assets: [] } : {
        canceled: false, assets: [{ uri: "fixture://selected-account-a", width: 1500, height: 1200 }],
      });
    } },
    ImageManipulator: { SaveFormat: { JPEG: "jpeg" }, ImageManipulator: { manipulate: uri => { calls.push({ manipulate: uri }); return context; } } },
    getApiIdentity: () => ({ ...identity }), assertApiIdentity,
    api: { upload: (route, asset, settings) => {
      assertApiIdentity(settings.expectedIdentity);
      uploads.push({ identity: { ...identity }, route, asset, settings });
      serverUser = { ...serverUser, picture: profileUser.picture };
      return stage("upload", { user: serverUser });
    }, delete: (route, _body, settings) => {
      assertApiIdentity(settings.expectedIdentity);
      calls.push({ deleteRoute: route, identity: { ...identity } });
      serverUser = { ...serverUser, picture: undefined };
      return stage("delete", { user: serverUser });
    }, patch: (route, body, settings) => {
      assertApiIdentity(settings.expectedIdentity);
      calls.push({ patchRoute: route, body, identity: { ...identity } });
      serverUser = { ...serverUser, name: body.displayName, phoneNumber: body.phoneNumber || undefined };
      return stage("patch", { user: serverUser });
    } },
    applyProfileUser: (user, expectedIdentity) => {
      assertApiIdentity(expectedIdentity);
      appliedProfiles.push({ user, identity: { ...identity } });
      currentUser = user;
    },
    runProfileWrite: queueModule.exports,
  };
  function mount() {
    const module = { exports: undefined };
    vm.runInNewContext(javascript, { ...globals, module }, { filename });
    return {
      raw: module.exports,
      run: () => module.exports.picture({ ...identity }),
      remove: () => module.exports.removePicture({ ...identity }),
      saveProfile: (displayName = "new name", phoneNumber = "0501234567") => module.exports.save({
        identity: { ...identity }, displayName, phoneNumber,
      }),
    };
  }
  return {
    ...mount(), remount: mount, calls, uploads, reached, appliedProfiles, profileUser,
    get currentUser() { return currentUser; },
    getIdentity: () => ({ ...identity }),
    beginSignOut: () => { epoch.current++; operation.current = "logout"; },
    resume: stage => gates[stage].resolve(),
    switchAccount: token => { identity = { token, generation: identity.generation + 1 }; epoch.current++; },
  };
}

test("the profile photo stays attached to its initiating identity through native preparation and upload", async () => {
  const h = harness();
  assert.equal(await h.run(), true);
  assert.equal(h.uploads.length, 1);
  assert.equal(h.uploads[0].identity.token, "account-a");
  assert.deepEqual(JSON.parse(JSON.stringify(h.uploads[0].settings)), {
    expectedIdentity: { token: "account-a", generation: 1 },
  });
  assert.equal(h.uploads[0].route, "/api/account/profile/picture");
  assert.equal(h.uploads[0].asset.uri, "fixture://rendered-account-a");
  assert.equal(h.uploads[0].asset.type, "image/jpeg");
  assert.deepEqual(JSON.parse(JSON.stringify(h.appliedProfiles[0].user)), h.profileUser);
  assert.equal(h.appliedProfiles[0].identity.token, "account-a");
  assert.equal(h.calls.some(call => call === "refresh"), false, "the server response updates the account without a second session read");
  assert.equal(h.calls.filter(call => call === "release-rendered").length, 1);
  assert.equal(h.calls.filter(call => call === "release-context").length, 1);
});

test("removing the profile photo applies the server's canonical user immediately", async () => {
  const h = harness();
  await h.remove();
  assert.deepEqual(h.calls.find(call => typeof call === "object" && "deleteRoute" in call), {
    deleteRoute: "/api/account/profile/picture",
    identity: { token: "account-a", generation: 1 },
  });
  assert.equal(h.appliedProfiles.length, 1);
  assert.equal(h.appliedProfiles[0].user.picture, undefined);
  assert.equal(h.appliedProfiles[0].identity.token, "account-a");
});

for (const paused of ["picker", "render", "save"]) {
  for (const switchBack of [false, true]) {
    test(`account switch during ${paused}${switchBack ? " and back to the original token" : ""} cannot submit a prepared profile photo`, async () => {
      const h = harness({ pause: paused });
      const pending = h.run();
      const rejection = assert.rejects(pending, error => error.code === "account_changed" && error.status === 409);
      await h.reached[paused].promise;
      h.switchAccount("account-b");
      if (switchBack) h.switchAccount("account-a");
      h.resume(paused);
      await rejection;
      assert.equal(h.uploads.length, 0);
      assert.equal(h.calls.includes("refresh"), false);
      assert.equal(h.appliedProfiles.length, 0);
      assert.equal(h.calls.includes("release-context"), paused !== "picker");
      assert.equal(h.calls.includes("release-rendered"), paused !== "picker");
    });
  }
}

test("a late completed upload for the old identity cannot refresh the new profile or report success", async () => {
  const h = harness({ pause: "upload" });
  const pending = h.run();
  const rejection = assert.rejects(pending, error => error.code === "account_changed");
  await h.reached.upload.promise;
  h.switchAccount("account-b");
  h.resume("upload");
  await rejection;
  assert.equal(h.uploads.length, 1);
  assert.equal(h.uploads[0].identity.token, "account-a");
  assert.equal(h.calls.includes("refresh"), false);
  assert.equal(h.appliedProfiles.length, 0);
  assert.equal(h.calls.includes("release-rendered"), true);
  assert.equal(h.calls.includes("release-context"), true);
});

for (const failed of ["resize", "render", "save", "upload"]) {
  test(`native image resources are released after ${failed} fails`, async () => {
    const h = harness({ fail: failed });
    await assert.rejects(h.run(), new RegExp(`${failed} failed`));
    assert.equal(h.calls.filter(call => call === "release-context").length, 1);
    assert.equal(h.calls.filter(call => call === "release-rendered").length,
      failed === "resize" || failed === "render" ? 0 : 1);
    assert.equal(h.calls.includes("refresh"), false);
    assert.equal(h.appliedProfiles.length, 0);
  });
}

test("cancelling the photo picker preserves the existing account picture without upload or refresh", async () => {
  const h = harness({ canceled: true });
  assert.equal(await h.run(), undefined);
  assert.equal(h.uploads.length, 0);
  assert.equal(h.calls.includes("refresh"), false);
  assert.equal(h.appliedProfiles.length, 0);
  assert.equal(h.calls.some(call => typeof call === "object" && "manipulate" in call), false);
});

const flush = () => new Promise(resolve => setImmediate(resolve));

test("saving name and phone applies the canonical user without a second session read", async () => {
  const h = harness();
  await h.saveProfile("updated name", "0555555555");
  const request = h.calls.find(call => call?.patchRoute);
  assert.equal(request.patchRoute, "/api/account/profile");
  assert.deepEqual(JSON.parse(JSON.stringify(request.body)), {
    displayName: "updated name", phoneNumber: "0555555555",
  });
  assert.equal(h.currentUser.name, "updated name");
  assert.equal(h.currentUser.phoneNumber, "0555555555");
  assert.equal(h.calls.includes("refresh"), false);
});

for (const paused of ["picker", "render", "save", "upload"]) {
  test(`profile removal and name save wait for the entire ${paused} upload operation`, async () => {
    const h = harness({ pause: paused });
    const upload = h.run();
    await h.reached[paused].promise;
    const removal = h.remove();
    const save = h.saveProfile();
    await flush();
    assert.equal(h.calls.includes("delete"), false);
    assert.equal(h.calls.includes("patch"), false);
    h.resume(paused);
    await Promise.all([upload, removal, save]);
    assert.deepEqual(h.calls.filter(call => ["upload", "delete", "patch"].includes(call)), ["upload", "delete", "patch"]);
    assert.equal(h.currentUser.picture, undefined);
    assert.equal(h.currentUser.name, "new name");
    assert.equal(h.currentUser.phoneNumber, "0501234567");
    assert.equal(h.appliedProfiles.length, 3);
  });
}

test("upload and name save wait for removal and preserve the final canonical profile", async () => {
  const h = harness({ pause: "delete" });
  const removal = h.remove();
  await h.reached.delete.promise;
  const upload = h.run();
  const save = h.saveProfile();
  await flush();
  assert.equal(h.calls.includes("picker"), false);
  assert.equal(h.calls.includes("patch"), false);
  h.resume("delete");
  await Promise.all([removal, upload, save]);
  assert.deepEqual(h.calls.filter(call => ["upload", "delete", "patch"].includes(call)), ["delete", "upload", "patch"]);
  assert.equal(h.currentUser.picture, h.profileUser.picture);
  assert.equal(h.currentUser.name, "new name");
});

test("reopening the account editor shares the pending upload queue", async () => {
  const h = harness({ pause: "upload" });
  const upload = h.run();
  await h.reached.upload.promise;
  const removal = h.remount().remove();
  await flush();
  assert.equal(h.calls.includes("delete"), false);
  h.resume("upload");
  await Promise.all([upload, removal]);
  assert.equal(h.currentUser.picture, undefined);
});

test("a failed upload releases queued removal and name saves", async () => {
  const h = harness({ pause: "upload", fail: "upload" });
  const upload = assert.rejects(h.run(), /upload failed/);
  await h.reached.upload.promise;
  const removal = h.remove();
  const save = h.saveProfile();
  h.resume("upload");
  await Promise.all([upload, removal, save]);
  assert.equal(h.currentUser.picture, undefined);
  assert.equal(h.currentUser.name, "new name");
});

for (const switchBack of [false, true]) {
  test(`queued profile writes reject an account change${switchBack ? " even when its token is reused" : ""}`, async () => {
    const h = harness({ pause: "upload" });
    const upload = assert.rejects(h.run(), error => error.code === "account_changed");
    await h.reached.upload.promise;
    const removal = assert.rejects(h.remove(), error => error.code === "account_changed");
    const save = assert.rejects(h.saveProfile(), error => error.code === "account_changed");
    h.switchAccount("account-b");
    if (switchBack) h.switchAccount("account-a");
    h.resume("upload");
    await Promise.all([upload, removal, save]);
    assert.equal(h.calls.includes("delete"), false);
    assert.equal(h.calls.includes("patch"), false);
    assert.equal(h.appliedProfiles.length, 0);
  });
}

for (const paused of ["picker", "render", "save"]) {
  test(`logout during ${paused} rejects queued writes before the bearer is cleared`, async () => {
    const h = harness({ pause: paused });
    const upload = assert.rejects(h.run(), error => error.code === "account_changed");
    await h.reached[paused].promise;
    const removal = assert.rejects(h.remove(), error => error.code === "account_changed");
    h.beginSignOut();
    assert.equal(h.getIdentity().token, "account-a");
    h.resume(paused);
    await Promise.all([upload, removal]);
    assert.equal(h.uploads.length, 0);
    assert.equal(h.calls.includes("delete"), false);
  });
}

test("a new account's profile queue does not wait for the old account's picker", async () => {
  const h = harness({ pause: "picker" });
  const upload = assert.rejects(h.run(), error => error.code === "account_changed");
  await h.reached.picker.promise;
  h.switchAccount("account-b");
  await h.saveProfile("account b");
  assert.equal(h.calls.find(call => call?.patchRoute).identity.token, "account-b");
  h.resume("picker");
  await upload;
});

for (const mutation of ["picture", "removePicture", "save"]) {
  test(`${mutation} retains the click identity across an asynchronous mutation handoff`, async () => {
    const h = harness();
    const identity = h.getIdentity();
    h.switchAccount("account-b");
    const variables = mutation === "save" ? { identity, displayName: "old", phoneNumber: "" } : identity;
    await assert.rejects(h.raw[mutation](variables), error => error.code === "account_changed");
    assert.equal(h.calls.length, 0);
  });
}
