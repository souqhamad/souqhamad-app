const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { verifyIosReleaseConfiguration } = require("../scripts/verify-ios-release.cjs");

const valid = {
  APP_VARIANT: "production",
  BUNDLE_ID: "com.souqhamad.app",
  EXPO_PUBLIC_API_URL: "https://souqhamad.com",
};

test("production iOS accepts Apple-only configuration without Google client values", () => {
  assert.deepEqual(verifyIosReleaseConfiguration(valid, "ios"), { checked: true });
});

test("production iOS rejects a development identity or a nonproduction API", () => {
  for (const bundle of [undefined, "", "com.souqhamad.app.dev", "com.souqhamad.app "])
    assert.throws(() => verifyIosReleaseConfiguration({ ...valid, BUNDLE_ID: bundle }, "ios"), /BUNDLE_ID/);
  for (const url of [undefined, "", "http://souqhamad.com", "https://souqhamad.com.invalid", "https://test.invalid", "https://user:password@souqhamad.com"])
    assert.throws(() => verifyIosReleaseConfiguration({ ...valid, EXPO_PUBLIC_API_URL: url }, "ios"), /EXPO_PUBLIC_API_URL/);
});

test("Android and development builds do not require iOS release inputs", () => {
  assert.deepEqual(verifyIosReleaseConfiguration({ APP_VARIANT: "production" }, "android"), { checked: false });
  assert.deepEqual(verifyIosReleaseConfiguration({ APP_VARIANT: "development" }, "ios"), { checked: false });
});

test("the release preflight runs without Google and fails before signing a wrong target", () => {
  const filename = path.resolve(__dirname, "../scripts/verify-ios-release.cjs");
  const environment = { ...process.env, ...valid, EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: "", EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME: "" };
  const configured = spawnSync(process.execPath, [filename, "--platform", "ios"], { env: environment, encoding: "utf8" });
  assert.equal(configured.status, 0);
  assert.match(configured.stdout, /Apple sign-in only/);
  const wrong = spawnSync(process.execPath, [filename, "--platform", "ios"], { env: { ...environment, BUNDLE_ID: "com.souqhamad.app.dev" }, encoding: "utf8" });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /BUNDLE_ID/);
});
