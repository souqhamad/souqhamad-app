import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Appearance, Platform, useColorScheme } from "react-native";
import * as SecureStore from "expo-secure-store";
import { darkColors, lightColors, normalizeThemePreference, resolveColorScheme, themeStorageKey, type ColorScheme, type ThemeColors, type ThemePreference } from "./theme";

type ThemeContextValue = {
  colors: ThemeColors;
  scheme: ColorScheme;
  preference: ThemePreference;
  setPreference: (value: ThemePreference) => void;
  ready: boolean;
};
const Context = createContext<ThemeContextValue | null>(null);
async function readPreference() {
  try {
    return normalizeThemePreference(Platform.OS === "web"
      ? globalThis.localStorage?.getItem(themeStorageKey)
      : await SecureStore.getItemAsync(themeStorageKey));
  } catch { return "system" as const; }
}
async function savePreference(value: ThemePreference) {
  try {
    if (Platform.OS === "web") globalThis.localStorage?.setItem(themeStorageKey, value);
    else await SecureStore.setItemAsync(themeStorageKey, value);
  } catch { /* Appearance remains usable if optional local storage is unavailable. */ }
}
export function AppThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [preference, updatePreference] = useState<ThemePreference>("system");
  const [ready, setReady] = useState(false);
  const revision = useRef(0);
  const storageQueue = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    let active = true;
    const version = revision.current;
    void readPreference().then(value => {
      if (!active) return;
      if (version === revision.current) updatePreference(value);
      setReady(true);
    });
    return () => { active = false; };
  }, []);
  const setPreference = useCallback((value: ThemePreference) => {
    const next = normalizeThemePreference(value);
    revision.current += 1;
    updatePreference(next);
    storageQueue.current = storageQueue.current.catch(() => {}).then(() => savePreference(next));
  }, []);
  const scheme = resolveColorScheme(preference, systemScheme);
  useEffect(() => {
    if (ready && Platform.OS !== "web") Appearance.setColorScheme(preference === "system" ? "auto" : preference);
  }, [preference, ready]);
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    document.documentElement.style.colorScheme = scheme;
  }, [scheme]);
  const value = useMemo(() => ({ colors: scheme === "dark" ? darkColors : lightColors, scheme, preference, setPreference, ready }), [scheme, preference, setPreference, ready]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useTheme() {
  const value = useContext(Context);
  if (!value) throw new Error("useTheme must be inside AppThemeProvider");
  return value;
}
export function createThemedStyles<T>(factory: (colors: ThemeColors) => T) {
  return function useThemedStyles() {
    const { colors } = useTheme();
    return useMemo(() => factory(colors), [colors]);
  };
}
