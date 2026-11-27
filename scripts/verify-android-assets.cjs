const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

function readAssetMap(inputPath) {
  const appRoot = fs.realpathSync(path.join(__dirname, ".."));
  const assetMapPath = fs.realpathSync(path.resolve(inputPath));
  const relativePath = path.relative(appRoot, assetMapPath);
  if (path.basename(assetMapPath) !== "assetmap.json" ||
      relativePath === ".." || relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)) {
    throw new Error("Expected an assetmap.json inside the mobile project.");
  }
  return JSON.parse(fs.readFileSync(assetMapPath, "utf8"));
}

// Use the resource naming functions used by this installed Expo CLI's native
// asset writer. Android resource names ignore extensions and strip punctuation.
const expoRequire = createRequire(require.resolve("@expo/cli/package.json"));
const { getAndroidResourceFolderName, getAndroidResourceIdentifier } =
  expoRequire("@react-native/asset-utils");

function verifyAndroidAssets(assetMap) {
  if (!assetMap || typeof assetMap !== "object" || Array.isArray(assetMap))
    throw new Error("Expected the assetmap.json from an Android-only Expo export.");
  const assets = Object.values(assetMap);
  if (!assets.length) throw new Error("The Android asset map is empty.");
  const resources = new Map();
  const conflicts = [];
  for (const asset of assets) {
    if (!asset || typeof asset.name !== "string" || !asset.name ||
        typeof asset.httpServerLocation !== "string" ||
        typeof asset.type !== "string" || !asset.type ||
        !Array.isArray(asset.scales) || !asset.scales.length ||
        !asset.scales.every(scale => Number.isFinite(scale) && scale > 0) ||
        !Array.isArray(asset.files) || asset.files.length !== asset.scales.length ||
        !asset.files.every(file => typeof file === "string" && file.length > 0))
      throw new Error("Malformed Android asset metadata; regenerate the Android asset map.");
    const assetResources = new Set();
    asset.scales.forEach((scale, index) => {
      const resource = `${getAndroidResourceFolderName(asset, scale)}/${getAndroidResourceIdentifier(asset)}`;
      // Metro can list both icon.png and icon@1x.png in the same asset group.
      // Expo copies these to one output file; they are not two native resources.
      if (assetResources.has(resource)) return;
      assetResources.add(resource);
      const source = asset.files[index];
      const existing = resources.get(resource);
      if (existing && existing !== source) conflicts.push({ resource, existing, source });
      else resources.set(resource, source);
    });
  }
  if (conflicts.length) {
    throw new Error("Duplicate Android resources. Rename one asset's basename:\n" +
      conflicts.map(({ resource, existing, source }) =>
        `${resource}\n  ${existing}\n  ${source}`).join("\n"));
  }
  return { assets: assets.length, resources: resources.size };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/verify-android-assets.cjs <android-export/assetmap.json>");
    const result = verifyAndroidAssets(readAssetMap(process.argv[2]));
    console.log(`Android assets verified: ${result.assets} bundled assets, ${result.resources} resources, no duplicate names.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { verifyAndroidAssets };
