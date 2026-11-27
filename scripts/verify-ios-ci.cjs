const { createPrivateKey } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveNativeBuildNumber } = require("./native-build-number.cjs");

const BUNDLE_IDENTIFIER = "com.souqhamad.app";
const ASSOCIATED_DOMAIN = "applinks:souqhamad.com";

function verifyIosCiEnvironment(environment) {
  for (const name of ["APP_STORE_CONNECT_ISSUER_ID", "APP_STORE_CONNECT_KEY_IDENTIFIER", "APP_STORE_CONNECT_PRIVATE_KEY", "CERTIFICATE_PRIVATE_KEY"]) {
    if (!environment[name]?.trim()) throw new Error(`${name} is required in the Codemagic ios_release group.`);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(environment.APP_STORE_CONNECT_ISSUER_ID))
    throw new Error("APP_STORE_CONNECT_ISSUER_ID must be the App Store Connect issuer UUID.");
  if (!/^[A-Z0-9]{10}$/.test(environment.APP_STORE_CONNECT_KEY_IDENTIFIER))
    throw new Error("APP_STORE_CONNECT_KEY_IDENTIFIER must be the 10-character App Store Connect key ID.");
  for (const [name, type] of [["APP_STORE_CONNECT_PRIVATE_KEY", "ec"], ["CERTIFICATE_PRIVATE_KEY", "rsa"]]) {
    let key;
    try {
      key = createPrivateKey(environment[name]);
    } catch {
      throw new Error(`${name} must contain the complete unencrypted PEM private key with actual line breaks.`);
    }
    if (key.asymmetricKeyType !== type || (type === "ec" && key.asymmetricKeyDetails?.namedCurve !== "prime256v1") || (type === "rsa" && key.asymmetricKeyDetails?.modulusLength < 2048))
      throw new Error(`${name} has the wrong key type; use ${type === "ec" ? "the App Store Connect P-256 .p8 key" : "an RSA distribution certificate private key of at least 2048 bits"}.`);
  }
  return { checked: true };
}

function verifyIosToolchain(xcodeVersion, sdkVersion) {
  const xcodeMajor = Number(xcodeVersion.match(/^Xcode (\d+)(?:\.\d+)*\s*$/m)?.[1]);
  if (!xcodeMajor || xcodeMajor < 26 || /beta/i.test(xcodeVersion))
    throw new Error("App Store uploads require a stable Xcode 26 or later.");
  if (!/^\d+(?:\.\d+)*$/.test(sdkVersion.trim()) || Number(sdkVersion.trim().split(".")[0]) < 26)
    throw new Error("App Store uploads require the iOS 26 SDK or later.");
  return { checked: true };
}

function verifyIosArchive(info, entitlements, profile, environment, now = new Date()) {
  const expectedVersion = require("../package.json").version;
  const expectedBuild = String(resolveNativeBuildNumber(environment));
  for (const [name, expected] of [["CFBundleIdentifier", BUNDLE_IDENTIFIER], ["CFBundleShortVersionString", expectedVersion], ["CFBundleVersion", expectedBuild]]) {
    if (String(info[name]) !== expected) throw new Error(`Signed IPA ${name} must be ${expected}.`);
  }
  const sdkVersion = (info.DTSDKName || "").match(/^iphoneos(\d+)(?:\.\d+)*$/);
  if (!sdkVersion || Number(sdkVersion[1]) < 26)
    throw new Error("Signed IPA must use the iOS 26 SDK or later.");
  if (!/^\d+(?:\.\d+)*$/.test(info.MinimumOSVersion || "") || Number(info.MinimumOSVersion.split(".")[0]) < 13)
    throw new Error("Signed IPA must target iOS 13 or later.");
  const orientations = info.UISupportedInterfaceOrientations;
  if (JSON.stringify(info.UIDeviceFamily) !== "[1]" || !Array.isArray(orientations) || !orientations.includes("UIInterfaceOrientationPortrait") || orientations.some((orientation) => orientation !== "UIInterfaceOrientationPortrait" && orientation !== "UIInterfaceOrientationPortraitUpsideDown"))
    throw new Error("Signed IPA must retain iPhone-only support and portrait orientation.");
  if (info.ITSAppUsesNonExemptEncryption !== false)
    throw new Error("Signed IPA must include the configured encryption declaration.");

  const team = entitlements["com.apple.developer.team-identifier"];
  const applicationIdentifier = `${team}.${BUNDLE_IDENTIFIER}`;
  const allowed = profile.Entitlements || {};
  if (!/^[A-Z0-9]{10}$/.test(team || "") || entitlements["application-identifier"] !== applicationIdentifier || allowed["application-identifier"] !== applicationIdentifier || allowed["com.apple.developer.team-identifier"] !== team)
    throw new Error("Signed IPA and provisioning profile must match the production bundle ID and Apple team.");
  if (entitlements["get-task-allow"] === true || allowed["get-task-allow"] === true || profile.ProvisionedDevices || profile.ProvisionsAllDevices)
    throw new Error("Signed IPA requires an App Store distribution provisioning profile.");
  if (!Number.isFinite(Date.parse(profile.ExpirationDate)) || Date.parse(profile.ExpirationDate) <= now.getTime())
    throw new Error("The IPA provisioning profile is expired or has no valid expiration date.");
  for (const capabilities of [entitlements, allowed]) {
    if (capabilities["aps-environment"] !== "production")
      throw new Error("Signed IPA and profile require the production Push Notifications entitlement.");
    if (!Array.isArray(capabilities["com.apple.developer.applesignin"]) || !capabilities["com.apple.developer.applesignin"].includes("Default"))
      throw new Error("Signed IPA and profile require the Sign in with Apple entitlement.");
  }
  if (!Array.isArray(entitlements["com.apple.developer.associated-domains"]) || !entitlements["com.apple.developer.associated-domains"].includes(ASSOCIATED_DOMAIN) || !Array.isArray(allowed["com.apple.developer.associated-domains"]) || !allowed["com.apple.developer.associated-domains"].some((domain) => domain === "*" || domain === ASSOCIATED_DOMAIN))
    throw new Error("Signed IPA and profile require the souqhamad.com Associated Domains entitlement.");
  return { version: expectedVersion, buildNumber: expectedBuild, bundleIdentifier: BUNDLE_IDENTIFIER };
}

function run(command, args, input) {
  const result = spawnSync(command, args, { encoding: "utf8", input, maxBuffer: 16 * 1024 * 1024 });
  // Do not print command output: Apple tooling may include signing identity details.
  if (result.error || result.status !== 0) throw new Error(`iOS release verification could not run ${command} successfully.`);
  return result.stdout;
}

function readPlist(contents, profile = false) {
  const script = "import datetime, json, plistlib, sys\np = plistlib.loads(sys.stdin.buffer.read())\nif sys.argv[1] == 'profile': p = {k: p[k] for k in ['Entitlements', 'ExpirationDate', 'ProvisionedDevices', 'ProvisionsAllDevices'] if k in p}\ndef serialize(value):\n    if isinstance(value, datetime.datetime): return value.replace(tzinfo=datetime.timezone.utc).isoformat()\n    raise TypeError('Unsupported plist value')\nprint(json.dumps(p, default=serialize))";
  return JSON.parse(run("python3", ["-c", script, profile ? "profile" : "plist"], contents));
}

function verifyIpaDirectory(directory, environment) {
  const files = fs.readdirSync(directory).filter((name) => name.endsWith(".ipa"));
  if (files.length !== 1) throw new Error("Expected exactly one signed IPA in the Codemagic IPA artifact directory.");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "souq-ios-release-"));
  try {
    run("unzip", ["-q", path.resolve(directory, files[0]), "-d", temporary]);
    const payload = path.join(temporary, "Payload");
    const applications = fs.readdirSync(payload).filter((name) => name.endsWith(".app"));
    if (applications.length !== 1) throw new Error("Expected exactly one application in the signed IPA.");
    const application = path.join(payload, applications[0]);
    run("codesign", ["--verify", "--deep", "--strict", application]);
    const info = readPlist(fs.readFileSync(path.join(application, "Info.plist")));
    const entitlements = readPlist(run("codesign", ["--display", "--entitlements", ":-", application]));
    const profile = readPlist(run("security", ["cms", "-D", "-i", path.join(application, "embedded.mobileprovision")]), true);
    return verifyIosArchive(info, entitlements, profile, environment);
  } finally {
    const resolved = fs.realpathSync(temporary);
    if (path.dirname(resolved) === fs.realpathSync(os.tmpdir()) && path.basename(resolved).startsWith("souq-ios-release-"))
      fs.rmSync(resolved, { recursive: true, force: true });
  }
}

module.exports = { verifyIosCiEnvironment, verifyIosToolchain, verifyIosArchive };

if (require.main === module) {
  try {
    if (process.argv.includes("--environment")) {
      verifyIosCiEnvironment(process.env);
      console.log("Codemagic iOS signing inputs are valid; values were not logged.");
    } else if (process.argv.includes("--toolchain")) {
      verifyIosToolchain(run("xcodebuild", ["-version"]), run("xcrun", ["--sdk", "iphoneos", "--show-sdk-version"]));
      console.log("The selected Xcode and iOS SDK meet App Store upload requirements.");
    } else if (process.argv.includes("--ipa-directory")) {
      const directory = process.argv[process.argv.indexOf("--ipa-directory") + 1];
      if (!directory) throw new Error("--ipa-directory requires the signed IPA artifact directory.");
      console.log(JSON.stringify(verifyIpaDirectory(directory, process.env)));
    } else {
      throw new Error("Specify --environment, --toolchain, or --ipa-directory <directory>.");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
