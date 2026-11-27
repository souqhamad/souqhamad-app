const { AndroidConfig, withAndroidColors, withAndroidColorsNight, withAndroidStyles } = require("@expo/config-plugins");

// Native dialogs and selection controls use the same day/night brand accent.
module.exports = function withBrandColors(config) {
  config = withAndroidColors(config, mod => {
    mod.modResults = AndroidConfig.Colors.assignColorValue(mod.modResults, { name: "hamad_accent", value: "#23765E" });
    return mod;
  });
  config = withAndroidColorsNight(config, mod => {
    mod.modResults = AndroidConfig.Colors.assignColorValue(mod.modResults, { name: "hamad_accent", value: "#A8D8C3" });
    return mod;
  });
  return withAndroidStyles(config, mod => {
    mod.modResults = AndroidConfig.Styles.assignStylesValue(mod.modResults, {
      add: true, parent: AndroidConfig.Styles.getAppThemeGroup(), name: "colorAccent", value: "@color/hamad_accent",
    });
    return mod;
  });
};
