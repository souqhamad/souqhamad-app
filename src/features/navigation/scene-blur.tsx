import { createContext, useContext, type ComponentRef, type ReactNode, type RefObject } from "react";
import { StyleSheet, View } from "react-native";
import { BlurTargetView } from "expo-blur";
import { useTheme } from "../../ui/theme-context";

type Target = RefObject<ComponentRef<typeof View> | null>;
const ContentTarget = createContext<Target | null>(null);

/** Keep fixed home controls out of the bottom bar's Android blur snapshot.
 * Other tabs retain their existing whole-scene target. */
export function NavigationScene({ children, target, contentTarget = false }: {
  children: ReactNode;
  target: Target;
  contentTarget?: boolean;
}) {
  return <ContentTarget.Provider value={contentTarget ? target : null}>
    {contentTarget
      ? <View style={styles.scene}>{children}</View>
      : <BlurTargetView ref={target} style={styles.scene}>{children}</BlurTargetView>}
  </ContentTarget.Provider>;
}

/** The feed keeps the same flex viewport; only its drawing target changes. */
export function NavigationBlurContent({ children }: { children: ReactNode }) {
  const target = useContext(ContentTarget);
  const { colors } = useTheme();
  return target
    ? <BlurTargetView ref={target} style={styles.scene}>
      <View style={[styles.scene, { backgroundColor: colors.background }]}>{children}</View>
    </BlurTargetView>
    : <>{children}</>;
}

const styles = StyleSheet.create({ scene: { flex: 1 } });
