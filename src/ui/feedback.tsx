import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AccessibilityInfo, AppState, BackHandler, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useIsFocused, usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../core/auth";
import { getSessionToken } from "../core/api";
import { userMessage } from "../core/errors";
import { feedbackStore, type FeedbackButton, type FeedbackTone } from "./feedback-store";
import { fonts } from "./theme";
import { useTheme } from "./theme-context";

const Context = createContext(false);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const ownerId = user?.id;
  const pathname = usePathname();
  const token = getSessionToken();
  useLayoutEffect(() => {
    // Logout and secure-session restore may briefly clear the user before the
    // bearer changes. Do not consume the logout result in that intermediate state.
    if (!ownerId && token) return;
    feedbackStore.setIdentity(`${ownerId ?? "guest"}:${token ?? ""}`, !ownerId && !token);
  }, [ownerId, token]);
  useLayoutEffect(() => {
    const dialog = feedbackStore.getSnapshot().dialog;
    if (dialog) feedbackStore.closeDialog(dialog.id);
  }, [pathname]);
  useEffect(() => () => feedbackStore.clear(), []);
  return <Context.Provider value>{children}</Context.Provider>;
}

export function useFeedback() {
  useContext(Context);
  const { user } = useAuth();
  const focused = useIsFocused();
  const alive = useRef(true);
  const visible = useRef(focused);
  useLayoutEffect(() => { visible.current = focused; }, [focused]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const token = getSessionToken();
  return useMemo(() => {
    const identityKey = `${user?.id ?? "guest"}:${token ?? ""}`;
    const current = () => alive.current && visible.current && getSessionToken() === token && feedbackStore.identity() === identityKey;
    const emit = (tone: FeedbackTone, message: string) => {
      if (current()) feedbackStore.enqueue(tone, message);
    };
    return {
      success: (message: string) => emit("success", message),
      info: (message: string) => emit("info", message),
      warning: (message: string) => emit("warning", message),
      error: (error: unknown, fallback?: string) => emit("error", userMessage(error, fallback)),
      alert: (title: string, message: string, buttons: FeedbackButton[]) => {
        if (current()) feedbackStore.openDialog(title, message, buttons);
      },
      capture: () => {
        const capturedScope = feedbackStore.scope();
        const capturedToken = getSessionToken();
        const previous = feedbackStore.getSnapshot().message;
        if (current() && previous?.tone === "error") feedbackStore.dismiss(previous.id);
        // Cache invalidation may still complete after its screen unmounts.
        // Message methods separately require a mounted, focused screen.
        return { isCurrent: () => getSessionToken() === capturedToken && feedbackStore.isCurrent(capturedScope) };
      },
      expectSignOut: (message: string) => { if (current()) feedbackStore.expectSignOut(message); },
    };
  // The account and token are deliberately part of the callback scope.
  }, [token, user?.id]);
}

// Existing confirmation semantics, rendered in the application's own theme.
export const SystemAlert = {
  alert(title: string, message?: string, buttons?: FeedbackButton[]) {
    feedbackStore.openDialog(title, message, buttons?.length ? buttons : [{ text: "حسنًا" }]);
  },
};
export function showFeedbackError(error: unknown, fallback?: string) {
  feedbackStore.enqueue("error", userMessage(error, fallback));
}

export function FeedbackHost({ modal = false }: { modal?: boolean }) {
  const enabled = useContext(Context);
  const focused = useIsFocused();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const snapshot = useSyncExternalStore(feedbackStore.subscribe, feedbackStore.getSnapshot, feedbackStore.getSnapshot);
  const [host, setHost] = useState<number | null>(null);
  const [appActive, setAppActive] = useState(AppState.currentState === "active");
  const [screenReader, setScreenReader] = useState(false);
  useEffect(() => {
    if (!enabled || !focused) return;
    const registration = feedbackStore.registerHost(modal ? 2 : 1);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Register with the external host registry only after this surface commits.
    setHost(registration.id);
    return registration.remove;
  }, [enabled, focused, modal]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", state => setAppActive(state === "active"));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isScreenReaderEnabled().then(value => { if (active) setScreenReader(value); }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener("screenReaderChanged", setScreenReader);
    return () => { active = false; subscription.remove(); };
  }, []);
  const owns = focused && host !== null && host === snapshot.host;
  const message = owns ? snapshot.message : null;
  const dialog = owns ? snapshot.dialog : null;
  useEffect(() => {
    if (!message || dialog || !appActive || screenReader || message.tone === "error") return;
    const timer = setTimeout(() => feedbackStore.dismiss(message.id), 4200);
    return () => clearTimeout(timer);
  }, [message, dialog, appActive, screenReader]);
  useEffect(() => {
    if (Platform.OS === "ios" && message) AccessibilityInfo.announceForAccessibility(message.message);
  }, [message]);
  const close = useCallback(() => {
    if (dialog) feedbackStore.closeDialog(dialog.id);
  }, [dialog]);
  useEffect(() => {
    if (!dialog) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => { close(); return true; });
    return () => sub.remove();
  }, [close, dialog]);
  if (!owns || (!message && !dialog)) return null;
  const foreground = message?.tone === "error" ? colors.danger : message?.tone === "success" ? colors.success : message?.tone === "warning" ? colors.warning : colors.info;
  const tint = message?.tone === "error" ? colors.dangerSoft : message?.tone === "success" ? colors.successSoft : colors.infoSoft;
  return <View pointerEvents="box-none" style={styles.layer}>
    {message && !dialog && <View style={[styles.toastPosition, { top: insets.top + 56 }]} pointerEvents="box-none">
      <View style={[styles.toast, { backgroundColor: colors.surface, borderColor: colors.border, shadowColor: colors.shadow }]}>
        <View style={[styles.glyph, { backgroundColor: tint }]}><Ionicons name={message.tone === "success" ? "checkmark-circle-outline" : message.tone === "error" ? "alert-circle-outline" : "information-circle-outline"} color={foreground} size={23} /></View>
        <Text accessibilityLiveRegion={message.tone === "error" ? "assertive" : "polite"} style={[styles.text, styles.message, { color: colors.text }]}>{message.message}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="إغلاق الرسالة" onPress={() => feedbackStore.dismiss(message.id)} style={styles.close}>
          <Ionicons name="close" size={20} color={colors.muted} />
        </Pressable>
      </View>
    </View>}
    {dialog && <View style={[styles.dialogBackdrop, { backgroundColor: colors.overlay, paddingTop: insets.top + 20, paddingBottom: insets.bottom + 20 }]} accessibilityViewIsModal>
      <View role="dialog" aria-label={dialog.title} style={[styles.dialog, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text accessibilityRole="header" style={[styles.text, styles.title, { color: colors.text }]}>{dialog.title}</Text>
        {dialog.message ? <ScrollView style={styles.dialogBody} contentContainerStyle={{ paddingBottom: 4 }}><Text style={[styles.text, { color: colors.muted }]}>{dialog.message}</Text></ScrollView> : null}
        <View style={styles.buttons}>{dialog.buttons.map((button, index) => <Pressable key={index} accessibilityRole="button" accessibilityLabel={button.text ?? "تأكيد"} onPress={() => feedbackStore.closeDialog(dialog.id, button)} style={({ pressed }) => [styles.dialogButton, { backgroundColor: button.style === "destructive" ? colors.dangerFill : button.style === "cancel" ? colors.subtle : colors.primaryFill, opacity: pressed ? 0.8 : 1 }]}>
          <Text style={[styles.text, styles.buttonText, { color: button.style === "cancel" ? colors.text : colors.onPrimary }]}>{button.text ?? "تأكيد"}</Text>
        </Pressable>)}</View>
      </View>
    </View>}
  </View>;
}
const styles = StyleSheet.create({
  layer: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, zIndex: 10000, elevation: 30 },
  toastPosition: { position: "absolute", left: 12, right: 12, alignItems: "center" },
  toast: { width: "100%", maxWidth: 520, flexDirection: "row-reverse", alignItems: "center", gap: 9, padding: 10, borderRadius: 18, borderWidth: 1, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.13, shadowRadius: 12, elevation: 6 },
  glyph: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  text: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 25, textAlign: "right", writingDirection: "rtl" },
  message: { flex: 1, minWidth: 0 },
  close: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  dialogBackdrop: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 20 },
  dialog: { width: "100%", maxWidth: 460, maxHeight: "85%", borderWidth: 1, borderRadius: 24, padding: 20, gap: 14 },
  title: { fontFamily: fonts.bold, fontSize: 18, lineHeight: 30 },
  dialogBody: { flexGrow: 0, flexShrink: 1 },
  buttons: { gap: 8 },
  dialogButton: { minHeight: 48, justifyContent: "center", alignItems: "center", borderRadius: 14, paddingHorizontal: 14, paddingVertical: 9 },
  buttonText: { fontFamily: fonts.medium, textAlign: "center" },
});
