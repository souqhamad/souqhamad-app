import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Image } from "expo-image";
import { AppText, Icon } from "../../ui";
import { useTheme } from "../../ui/theme-context";

type Props = {
  sources: readonly string[];
  localUri?: string;
  style: StyleProp<ViewStyle>;
  active: boolean;
  accessibilityLabel: string;
};

export function EditorImage(props: Props) {
  const sources = [...new Set(props.sources.filter(Boolean))];
  return <EditorImageContent key={JSON.stringify([sources, props.localUri])} {...props} sources={sources} />;
}

function EditorImageContent({ sources, localUri, style, active, accessibilityLabel }: Props) {
  const { colors } = useTheme();
  const [state, setState] = useState({ index: 0, attempt: 0, retries: 0, status: "loading" });
  const [localFailed, setLocalFailed] = useState(false);
  const [localReady, setLocalReady] = useState(false);
  const [localAttempt, setLocalAttempt] = useState(0);
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const { index, attempt, status } = state;
  const source = sources[index];
  const loaded = status === "loaded";
  const hasLocal = !!localUri && !localFailed;
  const exhausted = sources.length > 0 ? !source : !hasLocal;
  const failed = () => {
    if (!mounted.current) return;
    setState(current => current.index === index && current.attempt === attempt && current.status !== "loaded"
      ? { ...current, status: "error" } : current);
  };
  useEffect(() => {
    if (!active || !source || status !== "loading") return;
    const timer = setTimeout(() => {
      if (mounted.current) setState(current => current.index === index && current.attempt === attempt && current.status === "loading"
        ? { ...current, status: "error" } : current);
    }, 15_000);
    return () => clearTimeout(timer);
  }, [active, source, index, attempt, status]);
  useEffect(() => {
    if (!active || !source || status !== "error") return;
    const timer = setTimeout(() => {
      if (mounted.current) setState(current => current.index !== index || current.attempt !== attempt || current.status !== "error"
        ? current : current.retries < 1
          ? { ...current, attempt: current.attempt + 1, retries: current.retries + 1, status: "loading" }
          : { index: current.index + 1, attempt: current.attempt + 1, retries: 0, status: "loading" });
    }, 700);
    return () => clearTimeout(timer);
  }, [active, source, index, attempt, status]);
  const retry = () => {
    setState(current => ({ index: 0, attempt: current.attempt + 1, retries: 0, status: "loading" }));
    if (localFailed) { setLocalFailed(false); setLocalReady(false); setLocalAttempt(current => current + 1); }
  };
  return <View style={[style, styles.frame]} accessibilityLabel={accessibilityLabel}>
    {!!source && <Image
      key={`${source}:${attempt}`}
      source={source}
      style={StyleSheet.absoluteFill}
      contentFit="cover"
      cachePolicy="memory-disk"
      loading="eager"
      transition={0}
      onDisplay={() => {
        if (mounted.current) setState(current => current.index === index && current.attempt === attempt
          ? { ...current, status: "loaded" } : current);
      }}
      onError={failed}
    />}
    {hasLocal && !loaded && <Image
      key={`local:${localAttempt}`}
      source={localUri}
      style={StyleSheet.absoluteFill}
      contentFit="cover"
      cachePolicy="memory-disk"
      loading="eager"
      transition={0}
      onDisplay={() => { if (mounted.current) setLocalReady(true); }}
      onError={() => { if (mounted.current) { setLocalFailed(true); setLocalReady(false); } }}
    />}
    {!loaded && !localReady && !exhausted && <View pointerEvents="none" style={styles.center}>
      <ActivityIndicator size="small" color={colors.primary} />
    </View>}
    {exhausted && !loaded && <Pressable
      accessibilityRole="button"
      accessibilityLabel="إعادة تحميل الصورة"
      onPress={retry}
      style={[styles.retry, { backgroundColor: colors.surface }]}
    >
      <Icon name="refresh-outline" size={16} color={colors.primary} />
      <AppText variant="caption" color={colors.primary}>إعادة المحاولة</AppText>
    </Pressable>}
  </View>;
}

const styles = StyleSheet.create({
  frame: { overflow: "hidden" },
  center: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  retry: { position: "absolute", bottom: 4, alignSelf: "center", flexDirection: "row-reverse", alignItems: "center", gap: 4, padding: 4, borderRadius: 6 },
});
