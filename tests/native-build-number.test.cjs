const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const ts = require("typescript");
const buildNumbers = require("../scripts/native-build-number.cjs");

function appConfig(environment) {
  const filename = path.resolve(__dirname, "../app.config.ts");
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    javascript,
    {
      module,
      exports: module.exports,
      process: { env: environment },
      require: (id) => {
        assert.equal(id, "./scripts/native-build-number.cjs");
        return buildNumbers;
      },
    },
    { filename },
  );
  return module.exports.default({ config: {} });
}

test("non-Codemagic Expo configuration starts above confirmed store code 432", () => {
  for (const environment of [
    {},
    { APP_VARIANT: "production" },
    { EAS_BUILD: "true", EAS_BUILD_ID: "eas-build", PROJECT_BUILD_NUMBER: "40" },
    { CM_BUILD_ID: "", PROJECT_BUILD_NUMBER: "40" },
  ]) {
    const config = appConfig(environment);
    assert.equal(config.android.versionCode, 433);
    assert.equal(config.ios.buildNumber, "433");
    assert.ok(config.android.versionCode > 432);
    assert.equal(config.version, require("../package.json").version);
  }
});

test("successive Codemagic project builds produce newer Android and iOS packages", () => {
  const previous = appConfig({
    APP_VARIANT: "production",
    CM_BUILD_ID: "android-build",
    PROJECT_BUILD_NUMBER: "40",
    BUILD_NUMBER: "300",
  });
  const next = appConfig({
    APP_VARIANT: "production",
    CM_BUILD_ID: "ios-build",
    PROJECT_BUILD_NUMBER: "41",
    BUILD_NUMBER: "2",
  });
  assert.equal(previous.android.versionCode, 473);
  assert.equal(previous.ios.buildNumber, "473");
  assert.equal(next.android.versionCode, 474);
  assert.equal(next.ios.buildNumber, "474");
  assert.equal(next.android.package, "com.souqhamad.app");
  assert.equal(next.ios.bundleIdentifier, "com.souqhamad.app");
});

test("iOS release config retains portrait iPhone support and production Apple/APNs capabilities", () => {
  const config = appConfig({
    APP_VARIANT: "production",
    // Stale local Google values must not introduce iOS OAuth URL handling.
    EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME: "com.googleusercontent.apps.legacy",
  });
  assert.equal(config.orientation, "portrait");
  assert.equal(config.ios.supportsTablet, false);
  assert.equal(config.ios.usesAppleSignIn, true);
  assert.ok(config.ios.associatedDomains.includes("applinks:souqhamad.com"));
  assert.equal(config.ios.infoPlist.ITSAppUsesNonExemptEncryption, false);
  assert.ok(config.plugins.includes("expo-apple-authentication"));
  const notifications = config.plugins.find(value => Array.isArray(value) && value[0] === "expo-notifications");
  assert.equal(notifications[1].mode, "production");
  assert.equal(config.plugins.some(value => Array.isArray(value) && value[0] === "@react-native-google-signin/google-signin"), false);
  const development = appConfig({ APP_VARIANT: "development" });
  assert.equal(development.plugins.find(value => Array.isArray(value) && value[0] === "expo-notifications")[1].mode, "development");
});

test("the new release remains above the previous build formula for a continuing project counter", () => {
  for (const counter of [1, 29, 40, 41, 44, 1000]) {
    const previousBuild = 377 + counter;
    const nextBuild = buildNumbers.resolveNativeBuildNumber({
      CM_BUILD_ID: "next-release-build", PROJECT_BUILD_NUMBER: String(counter + 1),
    });
    assert.ok(nextBuild > previousBuild);
    assert.ok(nextBuild > 432);
    assert.equal(nextBuild, 433 + counter + 1);
  }
});

test("a reset Codemagic counter still starts above confirmed store code 432", () => {
  const minimumBuild = buildNumbers.resolveNativeBuildNumber({
    CM_BUILD_ID: "reset-project-build", PROJECT_BUILD_NUMBER: "1",
  });
  assert.equal(minimumBuild, 434);
  assert.ok(minimumBuild > 432);
});

test("Codemagic rejects missing or malformed counters instead of reusing a store build", () => {
  for (const counter of [
    undefined,
    "",
    " ",
    "0",
    "-1",
    "1.5",
    "1e3",
    "12builds",
    "Infinity",
    "01",
  ]) {
    assert.throws(
      () => appConfig({ CM_BUILD_ID: "codemagic-build", PROJECT_BUILD_NUMBER: counter }),
      /PROJECT_BUILD_NUMBER/,
    );
  }
});

test("Android's maximum version code is respected without rounding oversized input", () => {
  assert.equal(
    buildNumbers.resolveNativeBuildNumber({
      CM_BUILD_ID: "codemagic-build",
      PROJECT_BUILD_NUMBER: "2099999567",
    }),
    2_100_000_000,
  );
  for (const counter of ["2099999568", "9007199254740993"]) {
    assert.throws(
      () => buildNumbers.resolveNativeBuildNumber({ CM_BUILD_ID: "codemagic-build", PROJECT_BUILD_NUMBER: counter }),
      /versionCode limit/,
    );
  }
});

test("Codemagic preflight requires its build context and prints a fresh minimum code", () => {
  const script = path.resolve(__dirname, "../scripts/native-build-number.cjs");
  const environment = { ...process.env, CM_BUILD_ID: "", PROJECT_BUILD_NUMBER: "1" };
  const missingContext = spawnSync(process.execPath, [script, "--codemagic"], { env: environment, encoding: "utf8" });
  assert.equal(missingContext.status, 1);
  assert.match(missingContext.stderr, /CM_BUILD_ID/);
  const valid = spawnSync(process.execPath, [script, "--codemagic"], {
    env: { ...environment, CM_BUILD_ID: "release-build" }, encoding: "utf8",
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout), {
    version: require("../package.json").version, androidVersionCode: 434, iosBuildNumber: "434",
  });
});

test("Codemagic refuses a generated Android project that still contains store build 432", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "souq-release-version-"));
  const gradle = path.join(directory, "generated-build.gradle");
  const script = path.resolve(__dirname, "../scripts/native-build-number.cjs");
  const version = require("../package.json").version;
  const options = { env: { ...process.env, CM_BUILD_ID: "release-build", PROJECT_BUILD_NUMBER: "1" }, encoding: "utf8" };
  try {
    fs.writeFileSync(gradle, `versionCode 432\nversionName "${version}"\n`);
    const stale = spawnSync(process.execPath, [script, "--codemagic", "--android-gradle", gradle], options);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /found .*\(432\)/);
    fs.writeFileSync(gradle, `versionCode 434\nversionName "${version}"\n`);
    const fresh = spawnSync(process.execPath, [script, "--codemagic", "--android-gradle", gradle], options);
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(JSON.parse(fresh.stdout).androidVersionCode, 434);
  } finally {
    const resolvedDirectory = fs.realpathSync(directory);
    assert.equal(path.dirname(resolvedDirectory), fs.realpathSync(os.tmpdir()));
    fs.rmSync(resolvedDirectory, { recursive: true, force: true });
  }
});
