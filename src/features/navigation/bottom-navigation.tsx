import { useEffect, useState, type ComponentProps, type ComponentRef, type RefObject } from "react";
import { AccessibilityInfo, Keyboard, Platform, Pressable, StyleSheet, View } from "react-native";
import { BlurView } from "expo-blur";
import { Tabs } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useVisibleQuery as useQuery } from "../../core/visible-query";
import { api } from "../../core/api";
import { useAuth } from "../../core/auth";
import type { Conversation } from "../../core/types";
import { AppText, Icon, createThemedStyles, useTheme, type IconName } from "../../ui";

type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>["tabBar"]>>[0];
const destinations: { name: string; label: string; icon: IconName }[] = [
  { name: "listings", label: "إعلاناتي", icon: "add-circle-outline" },
  { name: "messages", label: "محادثاتي", icon: "chatbubble-outline" },
  { name: "index", label: "الرئيسية", icon: "home-outline" },
  { name: "favorites", label: "المفضلة", icon: "heart-outline" },
  { name: "account", label: "حسابي", icon: "person-outline" },
];
export function BottomNavigation({ state, emitter, navigateToTab, blurTarget }: TabBarProps & { blurTarget: RefObject<ComponentRef<typeof View> | null> }) {
  const { colors, scheme } = useTheme();
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [keyboard, setKeyboard] = useState(false);
  const [reduceTransparency, setReduceTransparency] = useState(false);
  const activeName = state.routes[state.index]?.name;
  const alerts = useQuery({
    queryKey: ["account", user?.id, "conversations", "alert"],
    queryFn: ({ signal }) => api.get<{ conversations: Conversation[] }>("/api/marketplace/me/conversations", { page: 1, limit: 48 }, { signal }),
    enabled: !!user, staleTime: 60_000, refetchInterval: 60_000,
  });
  const unread = !!user && alerts.data?.conversations.some(conversation => conversation.messages.some(message => {
    const readBy = message.metadata?.readBy;
    return message.status === "sent" && message.senderId !== user.id && !(readBy && typeof readBy === "object" && (readBy as Record<string, unknown>)[user.id]);
  }));
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => setKeyboard(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboard(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    let active = true;
    void AccessibilityInfo.isReduceTransparencyEnabled().then(value => {
      if (active) setReduceTransparency(value);
    }).catch(() => {});
    const listener = AccessibilityInfo.addEventListener("reduceTransparencyChanged", setReduceTransparency);
    return () => { active = false; listener.remove(); };
  }, []);
  const canBlur = !reduceTransparency && (Platform.OS !== "android" || Number(Platform.Version) >= 31);
  if (keyboard) return null;
  return <View testID="bottom-navigation" pointerEvents="box-none" style={[s.floating, {
    bottom: Math.max(insets.bottom, 8),
    paddingHorizontal: Math.max(insets.left, insets.right, 12),
  }]}>
    <View testID="navigation-content" pointerEvents="box-none" style={s.content}>
    <View testID="navigation-pill" pointerEvents="none" style={s.pill}>
      {canBlur ? <BlurView
        testID="navigation-glass"
        blurTarget={blurTarget}
        blurMethod="dimezisBlurViewSdk31Plus"
        tint={scheme === "dark" ? "systemUltraThinMaterialDark" : "systemUltraThinMaterialLight"}
        intensity={70}
        blurReductionFactor={3}
        style={[StyleSheet.absoluteFill, s.blur]}
      /> : null}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: canBlur ? colors.glassTint : colors.glassFallback }]} />
      <View style={s.glassHighlight} />
    </View>
      <View style={s.track}>
        {destinations.map(item => {
          const route = state.routes.find(entry => entry.name === item.name);
          if (!route) return null;
          const selected = activeName === item.name;
          const home = item.name === "index";
          return <Pressable key={item.name} accessibilityRole="button" accessibilityLabel={item.label} accessibilityState={{ selected }}
            aria-pressed={selected}
            onPress={() => {
              const event = emitter.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
              if (!selected && !event.defaultPrevented) navigateToTab(route.key);
            }}
            onLongPress={() => emitter.emit({ type: "tabLongPress", target: route.key })}
            style={({ pressed }) => [s.item, home && s.homeItem, pressed && s.pressed]}>
            <View testID={`navigation-circle-${item.name}`} style={[s.icon, selected && s.active, home && s.home, home && selected && s.homeSelected]}>
              <Icon name={home ? "home" : item.icon} size={home ? 28 : 21} color={home ? colors.onPrimary : selected ? colors.primary : colors.glassForeground} />
              {item.name === "messages" && unread && !selected && <View style={s.badge} />}
            </View>
            <AppText numberOfLines={1} variant={selected ? "label" : "caption"} style={s.label} color={colors.glassForeground}>{item.label}</AppText>
          </Pressable>;
        })}
      </View>
    </View>
  </View>;
}
const useStyles = createThemedStyles((colors) => StyleSheet.create({
  // Insets anchor the full-width host; only its child has a width limit.
  // Yoga prioritizes absolute left/right over alignSelf on a capped host.
  floating: { position: "absolute", left: 0, right: 0, height: 88, alignItems: "center", direction: "ltr", zIndex: 20 },
  content: { width: "100%", maxWidth: 480, height: 88 },
  pill: { position: "absolute", top: 14, bottom: 0, left: 0, right: 0, borderWidth: 1, borderColor: colors.glassBorder, borderRadius: 38, overflow: "hidden", boxShadow: `0 6px 22px ${colors.shadow}24` },
  blur: { borderRadius: 38, overflow: "hidden" },
  glassHighlight: { position: "absolute", top: 0, left: 26, right: 26, height: 1, backgroundColor: colors.glassHighlight },
  track: { height: 88, paddingHorizontal: 8, flexDirection: "row-reverse", direction: "ltr" },
  item: { flex: 1, minWidth: 44, height: 88, paddingTop: 14, borderRadius: 44, alignItems: "center", justifyContent: "center", gap: 3 },
  homeItem: { paddingTop: 0, justifyContent: "flex-start" },
  pressed: { opacity: 0.8 },
  icon: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: "transparent", alignItems: "center", justifyContent: "center" },
  active: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  home: { width: 56, height: 56, borderRadius: 28, borderWidth: 3, borderColor: colors.glassBorder, backgroundColor: colors.primaryFill, boxShadow: `0 4px 12px ${colors.shadow}38` },
  homeSelected: { borderColor: colors.primarySoft },
  label: { fontSize: 10, lineHeight: 17 },
  badge: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.dangerFill, position: "absolute", top: 0, right: 0, borderWidth: 1, borderColor: colors.surface },
}));
