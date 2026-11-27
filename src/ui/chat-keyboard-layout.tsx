import React, { useCallback, useEffect, useRef, useState, type ComponentRef } from "react";
import {
  AccessibilityInfo,
  Dimensions,
  Keyboard,
  Platform,
  StyleSheet,
  View,
  type KeyboardEvent,
  type KeyboardMetrics,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getChatKeyboardInsets } from "./chat-keyboard-geometry";
import { useTheme } from "./theme-context";

/** Keep the page header outside this layout; only messages and composer resize. */
export function ChatKeyboardLayout({ children }: { children: React.ReactNode }) {
  // Browsers resize their viewport themselves. Native Keyboard metrics are not
  // implemented by react-native-web, and native offsets must not reach the web.
  return Platform.OS === "web"
    ? <View style={styles.content}>{children}</View>
    : <NativeChatKeyboardLayout>{children}</NativeChatKeyboardLayout>;
}

function NativeChatKeyboardLayout({ children }: { children: React.ReactNode }) {
  const { bottom } = useSafeAreaInsets();
  const { colors } = useTheme();
  const viewport = useRef<ComponentRef<typeof View>>(null);
  const keyboard = useRef<KeyboardMetrics | null>(null);
  const animation = useRef<KeyboardEvent | null>(null);
  const scheduled = useRef<number | null>(null);
  const revision = useRef(0);
  const mounted = useRef(false);
  const [insets, setInsets] = useState({ overlap: 0, safeBottom: bottom });

  const measure = useCallback(() => {
    const currentRevision = ++revision.current;
    if (scheduled.current !== null) cancelAnimationFrame(scheduled.current);
    scheduled.current = requestAnimationFrame(() => {
      scheduled.current = null;
      viewport.current?.measureInWindow((x, y, width, height) => {
        if (!mounted.current || currentRevision !== revision.current) return;
        const next = getChatKeyboardInsets(
          { x, y, width, height }, keyboard.current, bottom,
        );
        if (animation.current) {
          Keyboard.scheduleLayoutAnimation(animation.current);
          animation.current = null;
        }
        setInsets(previous => previous.overlap === next.overlap &&
          previous.safeBottom === next.safeBottom ? previous : next);
      });
    });
  }, [bottom]);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    let eventVersion = 0;
    const update = (metrics: KeyboardMetrics | null, event: KeyboardEvent | null) => {
      const version = ++eventVersion;
      const apply = (next: KeyboardMetrics | null) => {
        if (!active || version !== eventVersion) return;
        keyboard.current = next;
        animation.current = event;
        measure();
      };
      if (Platform.OS === "ios" && metrics?.screenY === 0) {
        // Match RN's accessibility handling: iOS cross-fade transitions can
        // report a zero keyboard origin rather than a usable screen position.
        void AccessibilityInfo.prefersCrossFadeTransitions().then(
          crossFade => apply(crossFade ? null : metrics),
          () => apply(metrics),
        );
      } else apply(metrics);
    };
    const show = (event: KeyboardEvent) => update(event.endCoordinates, event);
    const hide = (event: KeyboardEvent) => update(null, event);
    const subscriptions = [
      Keyboard.addListener("keyboardDidShow", show),
      Keyboard.addListener("keyboardDidHide", hide),
      Dimensions.addEventListener("change", measure),
      ...(Platform.OS === "ios" ? [
        Keyboard.addListener("keyboardWillShow", show),
        Keyboard.addListener("keyboardWillChangeFrame", show),
        Keyboard.addListener("keyboardWillHide", hide),
      ] : []),
    ];
    update(Keyboard.metrics() ?? null, null);
    return () => {
      active = false;
      mounted.current = false;
      subscriptions.forEach(subscription => subscription.remove());
      if (scheduled.current !== null) cancelAnimationFrame(scheduled.current);
    };
  }, [measure]);

  return (
    <View ref={viewport} collapsable={false} style={styles.content} onLayout={measure}>
      {/* Padding stays inside the measured frame, so adjustResize and repeated
          keyboard events cannot subtract the same keyboard height twice. */}
      <View style={[styles.content, { paddingBottom: insets.overlap }]}>
        {children}
        {insets.safeBottom > 0 && <View style={{
          height: insets.safeBottom,
          flexShrink: 0,
          backgroundColor: colors.surface,
        }} />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({ content: { flex: 1, minHeight: 0 } });
