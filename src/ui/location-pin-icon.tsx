import { StyleSheet, View } from "react-native";
import { Icon } from "./index";
import { useTheme } from "./theme-context";

/** Filled map pin with a ground ring, drawn with native vector and view layers. */
export function LocationPinIcon() {
  const { colors } = useTheme();
  return <View accessible={false} pointerEvents="none" style={styles.root}>
    <View style={[styles.ground, { borderColor: colors.primary }]} />
    <View style={styles.pin}>
      <Icon name="location" size={28} color={colors.primary} />
    </View>
  </View>;
}

const styles = StyleSheet.create({
  root: { width: 28, height: 30 },
  ground: { position: "absolute", left: 2, bottom: 0, width: 24, height: 8, borderWidth: 1.5, borderRadius: 12 },
  pin: { position: "absolute", top: -2, left: 0 },
});
