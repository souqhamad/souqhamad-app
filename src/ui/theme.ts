export const lightColors = {
  primary: "#23765E",
  primaryDark: "#225B48",
  primaryFill: "#23765E",
  onPrimary: "#FFFFFF",
  primarySoft: "#EBF4EE",
  background: "#F7F9F8",
  surface: "#FFFFFF",
  card: "#FFFFFF",
  text: "#243A33",
  muted: "#586B63",
  border: "#DCE5DF",
  success: "#167A55",
  successSoft: "#E7F5EC",
  danger: "#A83244",
  dangerFill: "#AD3449",
  dangerSoft: "#FCECEE",
  warning: "#87611A",
  white: "#FFFFFF",
  foreground: "#243A33",
  secondary: "#EBF4EE",
  subtle: "#F0F4F2",
  overlay: "#03191088",
  mediaOverlay: "#031910D9",
  shadow: "#061E14",
  imageBackground: "#E5EEE8",
  pressed: "#DDEEE3",
  info: "#24635D",
  infoSoft: "#EAF5F2",
  // The blur material supplies its own tint; keep this brand wash translucent.
  glassTint: "#DAF1E51F",
  glassForeground: "#102D21",
  glassBorder: "#C4E7D8B3",
  glassHighlight: "#FFFFFF8C",
  glassFallback: "#F5FAF7F5",
};
export type ThemeColors = { [K in keyof typeof lightColors]: string };
export const darkColors: ThemeColors = {
  primary: "#A8D8C3", primaryDark: "#C2E8D5", primaryFill: "#377E65", onPrimary: "#FFFFFF",
  primarySoft: "#304B3D", background: "#18211E", surface: "#222E28", card: "#26322D",
  text: "#EFF5F1", muted: "#BCCBC2", border: "#42564A", success: "#A4DFBA",
  successSoft: "#2A4633", danger: "#FFB2B9", dangerFill: "#AD3449", dangerSoft: "#442B32",
  warning: "#E6C471", white: "#FFFFFF", foreground: "#EFF5F1", secondary: "#2C4035",
  subtle: "#1E2A24", overlay: "#00000099", shadow: "#000000", imageBackground: "#314139",
  pressed: "#3D5748", info: "#A7DAD2", infoSoft: "#28433D", mediaOverlay: "#031910D9",
  glassTint: "#102C2173", glassForeground: "#F1F9F4", glassBorder: "#A0D5BE80", glassHighlight: "#E3FFF24D", glassFallback: "#23352DF2",
};
export type ThemePreference = "system" | "light" | "dark";
export type ColorScheme = "light" | "dark";
export const themeStorageKey = "souq-hamad-appearance-v1";
export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}
export function resolveColorScheme(preference: ThemePreference, system: string | null | undefined): ColorScheme {
  return preference === "system" ? system === "dark" ? "dark" : "light" : preference;
}
export const colors = lightColors;
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
export const radius = { sm: 10, md: 16, lg: 22, xl: 28, pill: 999 };
export const fonts = {
  regular: "ArabicRegular",
  medium: "ArabicMedium",
  bold: "ArabicBold",
};
