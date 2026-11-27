import { useEffect, useRef, useState, type ElementRef } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, ScrollView, StyleSheet, View } from "react-native";
import { useScreenActive } from "../../core/visible-query";
import { AppText } from "../../ui";
import { createThemedStyles, useTheme } from "../../ui/theme-context";

type Message = { message: string; type: string; expiresAt?: string | null };
const copyGap = 28;
const pixelsPerSecond = 24;
const maxTimerDelayMs = 2_147_483_647;

/** The existing server-controlled message belongs to the fixed header. */
export function MarketHeaderMessage({ message }: { message?: Message | null }) {
  const text = message?.message.replace(/\s+/g, " ").trim();
  if (!message || !text) return null;
  const expiry = message.expiresAt ? Date.parse(message.expiresAt) : NaN;
  return <HeaderMessage key={`${expiry}:${text}`} text={text} type={message.type}
    expiresAt={Number.isFinite(expiry) ? expiry : undefined} />;
}

function HeaderMessage({ text, type, expiresAt }: { text: string; type: string; expiresAt?: number }) {
  const s = useStyles();
  const { colors } = useTheme();
  const screenActive = useScreenActive();
  const [expired, setExpired] = useState(() => expiresAt !== undefined && expiresAt <= Date.now());
  const active = screenActive && !expired;
  const [viewport, setViewport] = useState(0);
  const [textWidth, setTextWidth] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(true);
  const [progress] = useState(() => new Animated.Value(0));
  const scroll = useRef<ElementRef<typeof ScrollView>>(null);
  const overflow = viewport > 0 && textWidth > viewport + 1;
  const period = textWidth + copyGap;
  const moving = overflow && !reduceMotion;
  const color = type === "warning" ? colors.warning : type === "success" ? colors.success : colors.primary;

  useEffect(() => {
    if (!screenActive || expiresAt === undefined || expired) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const checkExpiry = () => {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) setExpired(true);
      else timer = setTimeout(checkExpiry, Math.min(remaining, maxTimerDelayMs));
    };
    checkExpiry();
    return () => { if (timer !== undefined) clearTimeout(timer); };
  }, [expired, expiresAt, screenActive]);

  useEffect(() => {
    if (expired) return;
    let live = true;
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    void AccessibilityInfo.isReduceMotionEnabled().then(value => {
      if (live) setReduceMotion(value);
    }).catch(() => { if (live) setReduceMotion(false); });
    return () => { live = false; subscription.remove(); };
  }, [expired]);

  useEffect(() => {
    progress.setValue(0);
    if (reduceMotion && overflow) scroll.current?.scrollToEnd({ animated: false });
    else scroll.current?.scrollTo({ x: 0, animated: false });
    if (!moving || !active) return;
    const animation = Animated.loop(Animated.timing(progress, {
      toValue: 1,
      duration: Math.round(period / pixelsPerSecond * 1000),
      easing: Easing.linear,
      // A perpetual header animation must never defer FlatList rendering.
      isInteraction: false,
      useNativeDriver: Platform.OS !== "web",
    }));
    animation.start();
    return () => { animation.stop(); };
  }, [active, moving, overflow, period, progress, reduceMotion]);

  if (expired) return null;

  // Identical copies exchange positions at the loop boundary. Positive travel
  // is always left-to-right, independent of the device's RTL layout setting.
  const translation = moving ? progress.interpolate({ inputRange: [0, 1],
    outputRange: [viewport - textWidth - period, viewport - textWidth] }) : 0;
  return <View testID="market-header-message" style={s.message} accessible accessibilityRole="text" accessibilityLabel={text}>
    <View style={s.clip} onLayout={event => setViewport(event.nativeEvent.layout.width)}>
      <ScrollView ref={scroll} horizontal scrollEnabled={reduceMotion && overflow} bounces={false}
        onContentSizeChange={() => { if (reduceMotion && overflow) scroll.current?.scrollToEnd({ animated: false }); }}
        showsHorizontalScrollIndicator={false} style={s.scroll}
        contentContainerStyle={[s.content, !overflow && s.centered]}
        accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Animated.View testID="market-header-message-track"
          renderToHardwareTextureAndroid={Platform.OS === "android" && moving && active}
          shouldRasterizeIOS={Platform.OS === "ios" && moving && active}
          style={[s.track, { transform: [{ translateX: translation }] }]}>
          <AppText numberOfLines={1} maxFontSizeMultiplier={1.3} style={[s.text, { color }]}
            onLayout={event => setTextWidth(event.nativeEvent.layout.width)}>{text}</AppText>
          {moving ? <AppText numberOfLines={1} maxFontSizeMultiplier={1.3} style={[s.text, { color }]} accessible={false}>{text}</AppText> : null}
        </Animated.View>
      </ScrollView>
    </View>
  </View>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  message: { flex: 1, minWidth: 0, height: 30, marginHorizontal: 8, paddingHorizontal: 7,
    borderRadius: 8, backgroundColor: colors.primarySoft, justifyContent: "center", overflow: "hidden" },
  clip: { height: 26, overflow: "hidden" },
  scroll: { flex: 1, direction: "ltr" },
  content: { minWidth: "100%", alignItems: "center", direction: "ltr" },
  centered: { justifyContent: "center" },
  track: { flexDirection: "row", alignItems: "center", gap: copyGap, direction: "ltr" },
  text: { flexShrink: 0, fontSize: 11.5, lineHeight: 19, textAlign: "right", writingDirection: "rtl" },
}));
