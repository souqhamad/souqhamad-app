const test = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { verifyIosCiEnvironment, verifyIosToolchain, verifyIosArchive } = require("../scripts/verify-ios-ci.cjs");
const { resolveNativeBuildNumber } = require("../scripts/native-build-number.cjs");

const apiKey = generateKeyPairSync("ec", { namedCurve: "prime256v1", privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
const certificateKey = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
const signingEnvironment = {
  APP_STORE_CONNECT_ISSUER_ID: "12345678-1234-1234-1234-123456789012",
  APP_STORE_CONNECT_KEY_IDENTIFIER: "ABC123DEF4",
  APP_STORE_CONNECT_PRIVATE_KEY: apiKey,
  CERTIFICATE_PRIVATE_KEY: certificateKey,
};

test("iOS CI accepts actual Apple API and certificate key types without a Google client", () => {
  assert.deepEqual(verifyIosCiEnvironment(signingEnvironment), { checked: true });
  for (const name of Object.keys(signingEnvironment)) {
    assert.throws(() => verifyIosCiEnvironment({ ...signingEnvironment, [name]: "" }), new RegExp(name));
  }
});

test("iOS CI rejects incompatible signing keys and never prints their contents", () => {
  const incompatibleInputs = [
    { APP_STORE_CONNECT_ISSUER_ID: "issuer-id" },
    { APP_STORE_CONNECT_KEY_IDENTIFIER: "short" },
    { APP_STORE_CONNECT_PRIVATE_KEY: "secret-invalid-pem-content" },
    { APP_STORE_CONNECT_PRIVATE_KEY: certificateKey },
    { CERTIFICATE_PRIVATE_KEY: apiKey },
    { CERTIFICATE_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 1024, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey },
    { APP_STORE_CONNECT_PRIVATE_KEY: generateKeyPairSync("ec", { namedCurve: "secp384r1", privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey },
    { APP_STORE_CONNECT_PRIVATE_KEY: apiKey.replace(/\n/g, "\\n") },
  ];
  for (const overrides of incompatibleInputs) {
    assert.throws(() => verifyIosCiEnvironment({ ...signingEnvironment, ...overrides }), error => {
      assert.ok(error instanceof Error);
      for (const value of Object.values(overrides)) assert.ok(!error.message.includes(value));
      return true;
    });
  }
  const cli = spawnSync(process.execPath, [path.resolve(__dirname, "../scripts/verify-ios-ci.cjs"), "--environment"], {
    env: { ...process.env, ...signingEnvironment, APP_STORE_CONNECT_PRIVATE_KEY: "secret-invalid-pem-content" }, encoding: "utf8",
  });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /APP_STORE_CONNECT_PRIVATE_KEY/);
  assert.doesNotMatch(cli.stderr + cli.stdout, /secret-invalid-pem-content|BEGIN PRIVATE KEY/);
});

test("iOS toolchain preflight rejects obsolete SDKs and beta Xcode", () => {
  assert.deepEqual(verifyIosToolchain("Xcode 26.6\nBuild version 17G42\n", "26.6\n"), { checked: true });
  assert.deepEqual(verifyIosToolchain("Xcode 27.0\nBuild version 18A1\n", "27.0"), { checked: true });
  for (const [xcode, sdk] of [
    ["Xcode 16.4\nBuild version 16F6", "26.0"],
    ["Xcode 26.6\nBuild version 17G42", "18.6"],
    ["Xcode 27.0 beta\nBuild version 18A1", "27.0"],
    ["Xcode 26.6\nBuild version 17G42", "26.beta"],
  ]) assert.throws(() => verifyIosToolchain(xcode, sdk));
});

const now = new Date("2026-11-01T12:00:00.000Z");
const archiveEnvironment = { CM_BUILD_ID: "fixture-ios-build", PROJECT_BUILD_NUMBER: "73" };
function archive() {
  const entitlements = {
    "application-identifier": "ABC123DEF4.com.souqhamad.app",
    "com.apple.developer.team-identifier": "ABC123DEF4",
    "get-task-allow": false,
    "aps-environment": "production",
    "com.apple.developer.applesignin": ["Default"],
    "com.apple.developer.associated-domains": ["applinks:souqhamad.com"],
  };
  return {
    info: {
      CFBundleIdentifier: "com.souqhamad.app",
      CFBundleShortVersionString: require("../package.json").version,
      CFBundleVersion: String(resolveNativeBuildNumber(archiveEnvironment)),
      DTSDKName: "iphoneos26.6",
      MinimumOSVersion: "16.0",
      UIDeviceFamily: [1],
      UISupportedInterfaceOrientations: ["UIInterfaceOrientationPortrait"],
      ITSAppUsesNonExemptEncryption: false,
    },
    entitlements,
    profile: { Entitlements: structuredClone(entitlements), ExpirationDate: "2027-11-01T12:00:00.000Z" },
  };
}
function verify(value) {
  return verifyIosArchive(value.info, value.entitlements, value.profile, archiveEnvironment, now);
}

test("signed iOS archive validation checks actual production identity and computed build", () => {
  assert.deepEqual(verify(archive()), { version: require("../package.json").version, buildNumber: String(resolveNativeBuildNumber(archiveEnvironment)), bundleIdentifier: "com.souqhamad.app" });
  for (const [key, value] of [
    ["CFBundleIdentifier", "com.souqhamad.app.dev"],
    ["CFBundleShortVersionString", "1.0.0"],
    ["CFBundleVersion", "328"],
    ["DTSDKName", "iphoneos18.6"],
    ["DTSDKName", "iphoneos26.invalid"],
    ["MinimumOSVersion", "12.4"],
    ["MinimumOSVersion", "unknown"],
    ["UIDeviceFamily", [1, 2]],
    ["UISupportedInterfaceOrientations", ["UIInterfaceOrientationPortrait", "UIInterfaceOrientationLandscapeLeft"]],
    ["ITSAppUsesNonExemptEncryption", undefined],
  ]) {
    const valueUnderTest = archive();
    valueUnderTest.info[key] = value;
    assert.throws(() => verify(valueUnderTest), undefined, key);
  }
});

test("signed iOS archive accepts Expo's upright and upside-down portrait orientations", () => {
  const value = archive();
  value.info.UISupportedInterfaceOrientations = ["UIInterfaceOrientationPortrait", "UIInterfaceOrientationPortraitUpsideDown"];
  assert.equal(verify(value).bundleIdentifier, "com.souqhamad.app");
  for (const orientations of [[], undefined, ["UIInterfaceOrientationPortraitUpsideDown"], ["UIInterfaceOrientationPortrait", "UIInterfaceOrientationLandscapeRight"]]) {
    value.info.UISupportedInterfaceOrientations = orientations;
    assert.throws(() => verify(value), /portrait orientation/);
  }
});

test("App Store archive preflight rejects development, Ad Hoc and expired profiles", () => {
  for (const modify of [
    value => { value.entitlements["get-task-allow"] = true; },
    value => { value.profile.Entitlements["get-task-allow"] = true; },
    value => { value.profile.ProvisionedDevices = ["fixture-device"]; },
    value => { value.profile.ProvisionsAllDevices = true; },
    value => { value.profile.ExpirationDate = now.toISOString(); },
    value => { value.profile.ExpirationDate = "invalid"; },
    value => { delete value.profile.ExpirationDate; },
    value => { value.entitlements["application-identifier"] = "DIFFERENT1.com.souqhamad.app"; },
    value => { value.profile.Entitlements["com.apple.developer.team-identifier"] = "DIFFERENT1"; },
    value => { value.profile.Entitlements["application-identifier"] = "ABC123DEF4.com.souqhamad.other"; },
  ]) {
    const value = archive();
    modify(value);
    assert.throws(() => verify(value));
  }
});

test("both signed entitlements and profile must support Apple login and production push", () => {
  for (const target of ["entitlements", "profile"]) {
    for (const [key, replacement] of [
      ["aps-environment", "development"],
      ["aps-environment", undefined],
      ["com.apple.developer.applesignin", []],
      ["com.apple.developer.applesignin", "Default"],
      ["com.apple.developer.associated-domains", ["applinks:other.invalid"]],
      ["com.apple.developer.associated-domains", "applinks:souqhamad.com"],
    ]) {
      const value = archive();
      const entitlements = target === "profile" ? value.profile.Entitlements : value.entitlements;
      entitlements[key] = replacement;
      assert.throws(() => verify(value), undefined, `${target}: ${key}`);
    }
  }
  const wildcardProfile = archive();
  wildcardProfile.profile.Entitlements["com.apple.developer.associated-domains"] = ["*"];
  assert.equal(verify(wildcardProfile).bundleIdentifier, "com.souqhamad.app");
});
