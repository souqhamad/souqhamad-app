import { useCallback, useEffect, useRef, type ComponentRef } from "react";
import { Keyboard, Platform, ScrollView, StyleSheet, TextInput, View, type KeyboardMetrics, type ScrollViewProps } from "react-native";
import { ChatKeyboardLayout } from "./chat-keyboard-layout";
import { getFormFieldScrollOffset } from "./form-keyboard-geometry";

type Props = Pick<ScrollViewProps, "children" | "contentContainerStyle" | "testID">;
type FocusedInput = ReturnType<typeof TextInput.State.currentlyFocusedInput>;

/** A bounded form viewport plus focused-input scrolling after native IME resize.
 * The page header stays outside. Manual overlap and iOS auto insets never stack.
 */
export function FormKeyboardScrollView(props: Props) {
  const viewport = useRef<ComponentRef<typeof View>>(null);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const focused = useRef<FocusedInput>(undefined);
  const focusPending = useRef(false);
  const manuallyScrolled = useRef(false);
  const keyboard = useRef<KeyboardMetrics | null>(null);
  const offset = useRef(0);
  const scheduled = useRef<number | null>(null);
  const revision = useRef(0);
  const mounted = useRef(false);

  const cancelMeasure = useCallback(() => {
    revision.current++;
    if (scheduled.current !== null) cancelAnimationFrame(scheduled.current);
    scheduled.current = null;
  }, []);
  const reveal = useCallback(() => {
    if (Platform.OS === "web" || !mounted.current || manuallyScrolled.current) return;
    cancelMeasure();
    const currentRevision = revision.current;
    scheduled.current = requestAnimationFrame(() => {
      scheduled.current = null;
      // Capture runs before TextInput updates native focus state. Read it on
      // the next frame, after the target has handled its focus event.
      if (focusPending.current) {
        focused.current = TextInput.State.currentlyFocusedInput();
        focusPending.current = false;
      }
      const input = focused.current;
      const host = viewport.current;
      const measuredOffset = offset.current;
      const current = () => mounted.current && currentRevision === revision.current &&
        !!input && !manuallyScrolled.current && viewport.current === host &&
        Math.abs(offset.current - measuredOffset) < 1 && TextInput.State.currentlyFocusedInput() === input;
      if (!input || !host || !current()) return;
      // React focus can bubble from a portaled selection modal. Require native
      // ancestry before comparing coordinates from its separate window.
      input.measureLayout(host, () => {
        if (!current()) return;
        host.measureInWindow((x, y, width, height) => {
          if (!current()) return;
          input.measureInWindow((fieldX, fieldY, fieldWidth, fieldHeight) => {
            if (!current()) return;
            const next = getFormFieldScrollOffset(
              { x, y, width, height },
              { x: fieldX, y: fieldY, width: fieldWidth, height: fieldHeight },
              measuredOffset, keyboard.current,
            );
            if (Math.abs(next - offset.current) > 1) scroll.current?.scrollTo({ y: next, animated: true });
          });
        });
      }, () => {});
    });
  }, [cancelMeasure]);

  useEffect(() => {
    mounted.current = true;
    if (Platform.OS === "web") return () => { mounted.current = false; cancelMeasure(); };
    keyboard.current = Keyboard.metrics() ?? null;
    const frameChanged: Parameters<typeof Keyboard.addListener>[1] = event => {
      keyboard.current = event.endCoordinates;
      reveal();
    };
    const show: typeof frameChanged = event => { manuallyScrolled.current = false; frameChanged(event); };
    const hide = () => { keyboard.current = null; reveal(); };
    const subscriptions = [
      Keyboard.addListener("keyboardDidShow", show),
      Keyboard.addListener("keyboardDidHide", hide),
      ...(Platform.OS === "ios" ? [
        Keyboard.addListener("keyboardWillChangeFrame", frameChanged),
        Keyboard.addListener("keyboardWillHide", hide),
      ] : []),
    ];
    return () => {
      mounted.current = false;
      cancelMeasure();
      subscriptions.forEach(subscription => subscription.remove());
    };
  }, [cancelMeasure, reveal]);

  return <ChatKeyboardLayout>
    <View ref={viewport} collapsable={false} style={styles.frame} onLayout={reveal}>
      <ScrollView
        {...props}
        ref={scroll}
        style={styles.frame}
        automaticallyAdjustKeyboardInsets={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        scrollEventThrottle={16}
        onContentSizeChange={reveal}
        onFocusCapture={() => {
          if (Platform.OS === "web") return;
          manuallyScrolled.current = false;
          focusPending.current = true;
          reveal();
        }}
        onBlurCapture={() => { focusPending.current = false; focused.current = undefined; cancelMeasure(); }}
        onScroll={({ nativeEvent }) => { offset.current = Math.max(0, nativeEvent.contentOffset.y); }}
        onScrollBeginDrag={() => { manuallyScrolled.current = true; cancelMeasure(); }}
      />
    </View>
  </ChatKeyboardLayout>;
}

const styles = StyleSheet.create({ frame: { flex: 1, minHeight: 0 } });
