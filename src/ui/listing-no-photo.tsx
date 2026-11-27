import { Image } from "expo-image";
import { StyleSheet, Text, View } from "react-native";
import { fonts, lightColors } from "./theme";

export function ListingNoPhoto() {
  return <ListingPhotoPlaceholder accessibilityLabel="إعلان بدون صور — سوق حمد" />;
}

/** Share the neutral artwork without claiming unavailable photos do not exist. */
export function ListingPhotoPlaceholder({ accessibilityLabel, message }: {
  accessibilityLabel: string;
  message?: string;
}) {
  return (
    <View style={styles.frame}>
      <Image
        accessible
        accessibilityLabel={accessibilityLabel}
        contentFit="contain"
        source={require("../../assets/hamad-market-wordmark.webp")}
        style={styles.wordmark}
        tintColor="#000000"
      />
      {message ? <Text style={styles.message}>{message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    backgroundColor: lightColors.white,
    justifyContent: "center",
  },
  wordmark: { width: "68%", maxWidth: 260, aspectRatio: 846 / 214, opacity: 0.2 },
  message: { position: "absolute", bottom: 9, left: 4, right: 4, fontFamily: fonts.regular,
    fontSize: 10, lineHeight: 16, textAlign: "center", color: lightColors.muted },
});
