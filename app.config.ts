import type { ConfigContext, ExpoConfig } from "expo/config";
import { resolveNativeBuildNumber } from "./scripts/native-build-number.cjs";

export default function config({ config }: ConfigContext): ExpoConfig {
  const production = process.env.APP_VARIANT === "production";
  const nativeBuildNumber = resolveNativeBuildNumber(process.env);
  const identifier = production ? "com.souqhamad.app" : "com.souqhamad.app.dev";
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON ||
    (production ? "./config/google-services.production.json" : undefined);
  return {
    ...config,
    name: production ? "سوق حمد" : "سوق حمد · تجربة",
    slug: "souq-hamad",
    version: "1.0.58",
    orientation: "portrait",
    scheme: production ? "smartstore" : "souqhamad-dev",
    icon: "./assets/app-icon.png",
    userInterfaceStyle: "automatic",
    primaryColor: "#23765E",
    ios: {
      buildNumber: String(nativeBuildNumber),
      supportsTablet: false,
      bundleIdentifier: identifier,
      usesAppleSignIn: true,
      associatedDomains: ["applinks:souqhamad.com"],
      infoPlist: {
        CFBundleAllowMixedLocalizations: true,
        CFBundleLocalizations: ["ar", "en"],
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: {
      versionCode: nativeBuildNumber,
      icon: "./assets/app-icon.png",
      package: identifier,
      predictiveBackGestureEnabled: true,
      googleServicesFile,
      permissions: [
        "android.permission.CAMERA",
        "android.permission.POST_NOTIFICATIONS",
      ],
      intentFilters: [
        {
          action: "VIEW",
          autoVerify: true,
          data: [
            {
              scheme: "https",
              host: "souqhamad.com",
              pathPrefix: "/listings/",
            },
            { scheme: "https", host: "souqhamad.com", pathPrefix: "/sellers/" },
            {
              scheme: "https",
              host: "souqhamad.com",
              pathPrefix: "/conversations/",
            },
          ],
          category: ["BROWSABLE", "DEFAULT"],
        },
      ],
    },
    web: { bundler: "metro", output: "single", favicon: "./assets/brand.png" },
    plugins: [
      "expo-router",
      "expo-image",
      "expo-font",
      "expo-system-ui",
      ["expo-secure-store", { faceIDPermission: false }],
      "expo-apple-authentication",
      ["expo-location", {
        locationWhenInUsePermission: "اسمح لسوق حمد بتحديد أقرب مدينة لعرض إعلانات منطقتك.",
        locationAlwaysAndWhenInUsePermission: false,
        locationAlwaysPermission: false,
        motionUsagePermission: false,
        locationFullAccuracyPermission: "اسمح لسوق حمد بتحديد موقعك لإظهار إعلانات قريبة منك.",
        isIosBackgroundLocationEnabled: false,
        isAndroidBackgroundLocationEnabled: false,
        isAndroidForegroundServiceEnabled: false,
      }],
      ["expo-build-properties", { android: { cmakeVersion: "3.31.6" } }],
      "./plugins/with-windows-cmake-object-path",
      "./plugins/with-codemagic-android-signing",
      "./plugins/with-notification-open-action",
      "./plugins/with-optional-android-hardware",
      "./plugins/with-brand-colors",
      [
        "expo-image-picker",
        {
          photosPermission:
            "اسمح لسوق حمد باختيار صور إعلانك أو صورتك الشخصية.",
          cameraPermission: "اسمح لسوق حمد بتصوير منتجك لإضافته إلى إعلانك.",
          microphonePermission: false,
        },
      ],
      ["expo-notifications", {
        color: "#23765E",
        defaultChannel: "default",
        mode: production ? "production" : "development",
      }],
      [
        "expo-splash-screen",
        {
          image: "./assets/launch-background.png",
          imageWidth: 1,
          backgroundColor: "#0D2B28",
        },
      ],
    ],
    experiments: { typedRoutes: true },
    extra: {
      ...config.extra,
      apiUrl: process.env.EXPO_PUBLIC_API_URL || "https://souqhamad.com",
      androidPushConfigured: Boolean(googleServicesFile),
    },
  };
}
