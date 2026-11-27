const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function harness(platform = "android", readAsset = async () => new Response(new Blob(["fixture"]))) {
  const filename = path.resolve(__dirname, "../src/core/api.ts");
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const writes = [];
  const module = { exports: {} };
  const imports = {
    "expo/fetch": { fetch: async (url, init) => { writes.push({ url, bearer: init.headers.get("authorization") }); return Response.json({ ok: true }); } },
    "expo-file-system": { File: class extends Blob { constructor() { super(["fixture"]); } } },
    "react-native": { Platform: { OS: platform } },
  };
  vm.runInNewContext(javascript, {
    module, exports: module.exports, require: id => { assert.ok(Object.hasOwn(imports, id)); return imports[id]; },
    URL, Headers, FormData, AbortController, setTimeout, clearTimeout, fetch: readAsset,
    process: { env: { EXPO_PUBLIC_API_URL: "https://fixture.invalid" } }, __DEV__: false,
  }, { filename });
  return { client: module.exports, writes };
}
const photo = { uri: "fixture://photo", name: "photo.jpg", type: "image/jpeg" };

test("an expected upload identity rejects a changed account before starting a request", async () => {
  const { client, writes } = harness();
  client.setApiIdentity("account-a");
  const expectedIdentity = client.getApiIdentity();
  client.setApiIdentity("account-b");
  await assert.rejects(client.api.upload("/api/account/profile/picture", photo, { expectedIdentity }), error => error.status === 409 && error.code === "account_changed");
  await assert.rejects(client.api.patch("/api/account/profile", {}, { expectedIdentity }), error => error.code === "account_changed");
  assert.equal(writes.length, 0);
});

test("logging out and returning to the same token cannot revive an older upload", async () => {
  const { client, writes } = harness();
  client.setApiIdentity("account-a");
  const expectedIdentity = client.getApiIdentity();
  client.setApiIdentity(null);
  client.setApiIdentity("account-a");
  await assert.rejects(client.api.upload("/api/account/profile/picture", photo, { expectedIdentity }), error => error.code === "account_changed");
  assert.equal(writes.length, 0);
});

test("a browser upload keeps its account while waiting for the local photo bytes", async () => {
  let finish;
  const bytes = new Promise(resolve => { finish = resolve; });
  const { client, writes } = harness("web", async () => ({ blob: () => bytes }));
  client.setApiIdentity("account-a");
  const pending = client.api.upload("/api/account/profile/picture", photo);
  client.setApiIdentity("account-b");
  finish(new Blob(["selected-photo"], { type: "image/jpeg" }));
  await assert.rejects(pending, error => error.code === "account_changed");
  assert.equal(writes.length, 0, "No POST may be sent under either account after the switch");
});

test("unchanged identity sends the image using the captured account", async () => {
  const { client, writes } = harness();
  client.setApiIdentity("account-a");
  const expectedIdentity = client.getApiIdentity();
  const result = await client.api.upload("/api/account/profile/picture", photo, { expectedIdentity });
  assert.equal(result.ok, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].bearer, "Bearer account-a");
});
