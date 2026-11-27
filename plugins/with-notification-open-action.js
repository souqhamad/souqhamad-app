const { withAndroidManifest } = require("expo/config-plugins");

// The existing server's FCM click_action is the literal OPEN_APP. Expo's
// short-action config expands it to android.intent.action.OPEN_APP, so keep
// this custom action explicit in the generated manifest.
module.exports = function withNotificationOpenAction(config) {
  return withAndroidManifest(config, mod => {
    const activities = mod.modResults.manifest.application?.[0]?.activity || [];
    const main = activities.find(activity => activity.$?.["android:name"] === ".MainActivity");
    if (!main) throw new Error("Cannot configure Android notification opening without MainActivity.");
    const filters = main["intent-filter"] || [];
    main["intent-filter"] = filters.filter(filter =>
      !filter.action?.some(action => action.$?.["android:name"] === "OPEN_APP"));
    main["intent-filter"].push({
      action: [{ $: { "android:name": "OPEN_APP" } }],
      category: [{ $: { "android:name": "android.intent.category.DEFAULT" } }],
    });
    return mod;
  });
};
