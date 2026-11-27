const { withAndroidManifest } = require("expo/config-plugins");
const optionalHardware = require("../config/android-optional-hardware.json");

// Keep the activity's preferred orientation and Expo Network's Wi-Fi
// permission while making them optional for Google Play device filtering.
module.exports = function withOptionalAndroidHardware(config) {
  return withAndroidManifest(config, mod => {
    const manifest = mod.modResults.manifest;
    const features = manifest["uses-feature"] ?? [];
    for (const name of optionalHardware) {
      const existing = features.find(feature => feature.$?.["android:name"] === name);
      if (existing) existing.$["android:required"] = "false";
      else features.push({ $: { "android:name": name, "android:required": "false" } });
    }
    manifest["uses-feature"] = features;
    return mod;
  });
};
