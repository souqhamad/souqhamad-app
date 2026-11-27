import { useCallback, useEffect, useMemo, useState } from "react";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider as NavigationThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from "@tanstack/react-query";
import { AppState, Platform, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  useFonts,
  IBMPlexSansArabic_400Regular,
  IBMPlexSansArabic_500Medium,
  IBMPlexSansArabic_600SemiBold,
} from "@expo-google-fonts/ibm-plex-sans-arabic";
import * as SplashScreen from "expo-splash-screen";
import * as SystemUI from "expo-system-ui";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { AuthProvider, useAuth } from "../core/auth";
import { useNativePushLifecycle } from "../core/push";
import { useRealtime } from "../core/realtime";
import { fonts } from "../ui/theme";
import { AppThemeProvider, useTheme } from "../ui/theme-context";
import { BrandWelcomeSplash } from "../features/welcome/brand-welcome";
import { FeedbackProvider } from "../ui/feedback";
import { ListingPublicationProvider } from "../core/listing-publication-context";
import { useAppUsage } from "../core/app-usage";
import { ListingCardNetworkRecoveryProvider } from "../ui/listing-card-recovery";
void SplashScreen.preventAutoHideAsync().catch(() => {});
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30000, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});
function AppLifecycle() {
  useAppUsage();
  const { user, status, refresh } = useAuth();
  useNativePushLifecycle(user?.id);
  useRealtime(user?.id, undefined, status !== "loading");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      focusManager.setFocused(state === "active");
      if (state === "active") void refresh();
    });
    return () => sub.remove();
  }, [refresh]);
  return null;
}
export default function RootLayout() {
  return <AppThemeProvider><RootContent /></AppThemeProvider>;
}
function RootContent() {
  const { colors, scheme, ready: themeReady } = useTheme();
  const [welcomeVisible, setWelcomeVisible] = useState(true);
  const [welcomeReady, setWelcomeReady] = useState(false);
  const readyWelcome = useCallback(() => setWelcomeReady(true), []);
  const finishWelcome = useCallback(() => setWelcomeVisible(false), []);
  const [loaded, error] = useFonts({
    ArabicRegular: IBMPlexSansArabic_400Regular,
    ArabicMedium: IBMPlexSansArabic_500Medium,
    ArabicBold: IBMPlexSansArabic_600SemiBold,
  });
  useEffect(() => {
    if ((loaded || error) && welcomeReady) void SplashScreen.hideAsync().catch(() => {});
  }, [loaded, error, welcomeReady]);
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(welcomeVisible ? "#0D2B28" : colors.background).catch(() => {});
  }, [welcomeVisible, colors.background]);
  const navigationTheme = useMemo(() => {
    const base = scheme === "dark" ? DarkTheme : DefaultTheme;
    return { ...base, colors: { ...base.colors, primary: colors.primary, background: colors.background, card: colors.surface, text: colors.text, border: colors.border, notification: colors.danger } };
  }, [colors, scheme]);
  if ((!loaded && !error) || !themeReady)
    return <View style={{ flex: 1, backgroundColor: "#0D2B28" }} />;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <NavigationThemeProvider value={navigationTheme}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <FeedbackProvider>
            <ListingPublicationProvider>
            <ListingCardNetworkRecoveryProvider>
            <AppLifecycle />
            <StatusBar style={welcomeVisible || scheme === "dark" ? "light" : "dark"} />
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.background },
                animation:
                  Platform.OS === "android"
                    ? "fade_from_bottom"
                    : "slide_from_right",
                headerTitleStyle: { fontFamily: fonts.bold },
              }}
            >
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="auth" options={{ presentation: "modal" }} />
            </Stack>
            {welcomeVisible && <BrandWelcomeSplash onFinish={finishWelcome} onReady={readyWelcome} ready={welcomeReady} />}
            </ListingCardNetworkRecoveryProvider>
            </ListingPublicationProvider>
            </FeedbackProvider>
          </AuthProvider>
        </QueryClientProvider>
        </NavigationThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
