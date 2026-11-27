const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { verifyGoogleServices, prepareAndroidRelease, verifyGeneratedAndroid } = require("../scripts/verify-android-release.cjs");

const fixture = (packageName = "com.souqhamad.app") => ({
  project_info: { project_id: "fixture-project", project_number: "123456789" },
  client: [{ client_info: { mobilesdk_app_id: "1:123456789:android:abcdef", android_client_info: { package_name: packageName } }, api_key: [{ current_key: "fixture-public-client-identifier" }] }],
});

test("Android notification preflight rejects a different package and server private-key files", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hamad-fcm-check-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "client.json");
  fs.writeFileSync(filename, JSON.stringify(fixture("com.souqhamad.app.dev")));
  assert.throws(() => verifyGoogleServices(filename), /registered client/);
  fs.writeFileSync(filename, JSON.stringify({ type: "service_account", private_key: "fixture-not-a-key" }));
  assert.throws(() => verifyGoogleServices(filename), /never a server service-account/);
  assert.throws(() => verifyGoogleServices(path.join(directory, "missing.json")), /missing or invalid/);
});

test("a validated client override is prepared before Expo and exported as a file path for Codemagic", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hamad-fcm-prepare-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cmEnv = path.join(directory, "codemagic.env");
  const data = fixture();
  const result = prepareAndroidRelease({ GOOGLE_SERVICES_JSON_BASE64: Buffer.from(JSON.stringify(data)).toString("base64"), CM_ENV: cmEnv }, directory);
  assert.deepEqual(result, { packageName: "com.souqhamad.app", projectId: "fixture-project" });
  const filename = path.join(directory, ".data", "google-services.release.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, "utf8")), data);
  assert.equal(fs.readFileSync(cmEnv, "utf8"), `GOOGLE_SERVICES_JSON=${filename}\n`);
  assert.throws(() => prepareAndroidRelease({ GOOGLE_SERVICES_JSON_BASE64: "%%%invalid%%%" }, directory), /valid base64/);
});

test("the registered production client is present and contains no service-account key", () => {
  const filename = path.resolve(__dirname, "../config/google-services.production.json");
  assert.deepEqual(verifyGoogleServices(filename), { packageName: "com.souqhamad.app", projectId: "souqhamad" });
});

test("the generated Android app must initialize Firebase, handle notifications, and declare optional hardware", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hamad-fcm-native-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, "app/src/main"), { recursive: true });
  fs.writeFileSync(path.join(directory, "app/google-services.json"), JSON.stringify(fixture()));
  const gradle = path.join(directory, "app/build.gradle");
  const manifest = path.join(directory, "app/src/main/AndroidManifest.xml");
  fs.writeFileSync(gradle, "apply plugin: 'com.android.application'");
  fs.writeFileSync(manifest, '<action android:name="android.intent.action.OPEN_APP"/>');
  assert.throws(() => verifyGeneratedAndroid(directory), /initialize the Google Services/);
  fs.appendFileSync(gradle, "\napply plugin: 'com.google.gms.google-services'");
  assert.throws(() => verifyGeneratedAndroid(directory), /server's OPEN_APP/);
  const action = '<action android:name="OPEN_APP"/>';
  const portrait = '<uses-feature android:name="android.hardware.screen.portrait" android:required="false"/>';
  const wifi = '<uses-feature android:required="false" android:name="android.hardware.wifi"/>';
  fs.writeFileSync(manifest, action);
  assert.throws(() => verifyGeneratedAndroid(directory), /android\.hardware\.screen\.portrait/);
  fs.writeFileSync(manifest, action + portrait + wifi.replace('="false"', '="true"'));
  assert.throws(() => verifyGeneratedAndroid(directory), /android\.hardware\.wifi/);
  fs.writeFileSync(manifest, action + portrait + wifi + wifi);
  assert.throws(() => verifyGeneratedAndroid(directory), /android\.hardware\.wifi/);
  fs.writeFileSync(manifest, action + portrait + wifi);
  assert.equal(verifyGeneratedAndroid(directory).packageName, "com.souqhamad.app");
});
