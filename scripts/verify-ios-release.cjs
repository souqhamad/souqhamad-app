function verifyIosReleaseConfiguration(environment, platform) {
  if (platform !== "ios" || environment.APP_VARIANT !== "production")
    return { checked: false };

  // Apple sign-in is native. Google OAuth configuration belongs to Android.
  if (environment.BUNDLE_ID !== "com.souqhamad.app")
    throw new Error("Production iOS BUNDLE_ID must be com.souqhamad.app.");
  if (environment.EXPO_PUBLIC_API_URL !== "https://souqhamad.com")
    throw new Error("Production iOS EXPO_PUBLIC_API_URL must be https://souqhamad.com.");
  return { checked: true };
}

module.exports = { verifyIosReleaseConfiguration };

if (require.main === module) {
  const platformFlag = process.argv.indexOf("--platform");
  const platform = platformFlag >= 0 ? process.argv[platformFlag + 1] : process.env.EAS_BUILD_PLATFORM;
  if (platform !== "ios" && platform !== "android") {
    console.error("Specify the build platform: node scripts/verify-ios-release.cjs --platform ios");
    process.exitCode = 1;
  } else {
    try {
      const result = verifyIosReleaseConfiguration(process.env, platform);
      console.log(result.checked ? "Production iOS identity and API configuration are valid (Apple sign-in only)." : "iOS release validation does not apply to this build.");
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
