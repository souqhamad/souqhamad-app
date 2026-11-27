const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { verifyAndroidAssets } = require("../scripts/verify-android-assets.cjs");

function asset(name, type, scales = [1], location = "/assets/assets") {
  return { name, type, scales, httpServerLocation: location,
    files: scales.map(scale => `${location}/${name}@${scale}x.${type}`) };
}

test("rejects the PNG/WebP wordmark collision seen in the Android release build", () => {
  assert.throws(() => verifyAndroidAssets({
    webp: asset("hamad-market-wordmark", "webp"),
    png: asset("hamad-market-wordmark", "png"),
  }), /Duplicate Android resources[\s\S]*drawable-mdpi\/assets_hamadmarketwordmark[\s\S]*webp[\s\S]*png/);
});

test("a separate fallback basename preserves both wordmark assets", () => {
  assert.deepEqual(verifyAndroidAssets({
    webp: asset("hamad-market-wordmark", "webp"),
    png: asset("hamad-market-wordmark-fallback", "png"),
  }), { assets: 2, resources: 2 });
});

test("uses native resource normalization for punctuation, case, and density", () => {
  assert.throws(() => verifyAndroidAssets({
    first: asset("Brand-Logo", "png", [1, 2]),
    second: asset("brandlogo", "webp", [2]),
  }), /drawable-xhdpi\/assets_brandlogo/);
  assert.deepEqual(verifyAndroidAssets({
    mdpi: asset("brand-logo", "png", [1]),
    xhdpi: asset("brand-logo", "webp", [2]),
    otherFolder: asset("brand-logo", "png", [1], "/assets/icons"),
    raw: asset("brand-logo", "ttf", [1]),
  }), { assets: 4, resources: 4 });
});

test("fails closed when the export map is missing or malformed", () => {
  for (const invalid of [null, [], {}, { asset: {} },
    { asset: asset("logo", "png", [0]) }]) {
    assert.throws(() => verifyAndroidAssets(invalid), /Expected|empty|Malformed/);
  }
});

test("permits Metro's default and explicit 1x aliases within one asset group", () => {
  const icon = asset("clear-icon", "png", [1, 1, 2, 3]);
  icon.files[0] = "/assets/assets/clear-icon.png";
  assert.deepEqual(verifyAndroidAssets({ icon }), { assets: 1, resources: 3 });
});

test("Android asset CLI reads its project export and rejects files outside the project", t => {
  const appRoot = path.resolve(__dirname, "..");
  const diagnostics = path.join(appRoot, ".data");
  fs.mkdirSync(diagnostics, { recursive: true });

  function writeAssetMap(directory) {
    const fixture = fs.mkdtempSync(path.join(directory, "asset-check-"));
    const file = path.join(fixture, "assetmap.json");
    t.after(() => {
      fs.rmSync(file, { force: true });
      fs.rmdirSync(fixture);
    });
    fs.writeFileSync(file, JSON.stringify({ logo: asset("logo", "png") }));
    return file;
  }

  const cli = path.join(appRoot, "scripts/verify-android-assets.cjs");
  const check = file => spawnSync(process.execPath, [cli, file], { cwd: appRoot, encoding: "utf8" });
  const valid = check(path.relative(appRoot, writeAssetMap(diagnostics)));
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /1 bundled assets/);

  const outside = check(writeAssetMap(os.tmpdir()));
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /Expected an assetmap.json inside the mobile project/);
});
