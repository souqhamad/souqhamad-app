import { Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { openAssistant } from "../../features/assistant/entry";
import { AppText, Card, Icon, PageHeader, Screen, createThemedStyles, useTheme } from "../../ui";
export default function CreateRoute() {
  const { colors } = useTheme();
  const s = useStyles();
  return (
    <Screen>
      <PageHeader title="أضف إعلانك" subtitle="اختر الطريقة المناسبة لك" back />
      <View style={s.content}>
        <View style={s.hero}>
          <View style={s.mark}>
            <Icon name="add" size={38} color={colors.primary} />
          </View>
          <AppText variant="title">فرصتك تبدأ بإعلان</AppText>
          <AppText color={colors.muted} style={{ textAlign: "center" }}>
            صوّر، أضف التفاصيل، ثم شارك إعلانك مع السوق.
          </AppText>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push("/create/manual")}
        >
          <Card style={s.choice}>
            <View style={s.icon}>
              <Icon name="create-outline" size={27} color={colors.primary} />
            </View>
            <View style={s.grow}>
              <AppText variant="heading">أدخل التفاصيل بنفسك</AppText>
              <AppText variant="caption" color={colors.muted}>
                خطوات واضحة، صور، ومعاينة قبل النشر
              </AppText>
            </View>
            <Icon name="chevron-back" size={20} color={colors.muted} />
          </Card>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => openAssistant("listing")}
        >
          <Card style={s.choice}>
            <View style={s.icon}>
              <Icon name="sparkles-outline" size={27} color={colors.primary} />
            </View>
            <View style={s.grow}>
              <AppText variant="heading">أنشئ مع حمد</AppText>
              <AppText variant="caption" color={colors.muted}>
                احكِ عن منتجك ليجهّز حمد مسودة تراجعها
              </AppText>
            </View>
            <Icon name="chevron-back" size={20} color={colors.muted} />
          </Card>
        </Pressable>
        <AppText
          variant="caption"
          color={colors.muted}
          style={{ textAlign: "center", marginTop: 10 }}
        >
          المسودة لك. مراجعتها ونشرها بيدك.
        </AppText>
      </View>
    </Screen>
  );
}
const useStyles = createThemedStyles((colors) => StyleSheet.create({
  content: { padding: 20, gap: 16 },
  hero: { alignItems: "center", gap: 13, paddingVertical: 24 },
  mark: {
    width: 84,
    height: 84,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primarySoft,
    marginBottom: 6,
  },
  choice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 23,
  },
  grow: { flex: 1, gap: 7 },
  icon: {
    width: 52,
    height: 52,
    borderRadius: 17,
    backgroundColor: colors.primarySoft,
    alignItems: "center",
    justifyContent: "center",
  },
}));
