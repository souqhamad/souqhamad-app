import { Image, Pressable, StyleSheet, View } from "react-native";
import { formatPrice } from "../../core/presentation";
import { AppText, Button, Card, Icon } from "../../ui";
import { createThemedStyles, useTheme } from "../../ui/theme-context";
import type { HamadDraftAction, HamadDraftCard, HamadDraftPage, HamadDraftPreview } from "./drafts";

const modifiedDate = new Intl.DateTimeFormat("ar-SA-u-ca-gregory", { dateStyle: "short", timeZone: "Asia/Riyadh" });

function DraftRow({ draft }: { draft: HamadDraftCard }) {
  const { colors } = useTheme();
  const s = useStyles();
  return (
    <View style={s.row}>
      {draft.thumbnail ? <Image source={{ uri: draft.thumbnail }} style={s.thumbnail} /> : (
        <View style={[s.thumbnail, s.placeholder]}>
          <Icon name="document-text-outline" size={22} color={colors.primary} />
        </View>
      )}
      <View style={s.details}>
        <AppText variant="label" numberOfLines={2}>{draft.title}</AppText>
        <AppText variant="caption" color={colors.muted}>{formatPrice(draft.price)}</AppText>
        <AppText variant="caption" color={colors.muted}>آخر تعديل {modifiedDate.format(new Date(draft.modified))}</AppText>
      </View>
    </View>
  );
}

export function HamadDraftCards({ page, disabled, onAction }: {
  page: HamadDraftPage;
  disabled: boolean;
  onAction: (action: HamadDraftAction) => void;
}) {
  const s = useStyles();
  return (
    <View style={s.list} testID="hamad-draft-picker">
      <AppText variant="label">{page.refreshed ? "تحدّثت القائمة. اختر المسودة من جديد." : "اختر مسودة"}</AppText>
      {page.cards.map((draft, index) => (
        <Pressable
          key={index}
          accessibilityRole="button"
          accessibilityLabel={`اختيار المسودة ${draft.title}`}
          disabled={disabled}
          testID={`hamad-draft-choice-${index + 1}`}
          onPress={() => onAction({ type: "select", page: page.key, choice: index + 1 })}
          style={({ pressed }) => pressed && s.pressed}
        >
          <Card style={s.card}><DraftRow draft={draft} /></Card>
        </Pressable>
      ))}
      {page.hasNext && <Button title="مسودات أخرى" variant="secondary" disabled={disabled}
        onPress={() => onAction({ type: "next", page: page.key })} />}
    </View>
  );
}

export function HamadSelectedDraft({ draft }: { draft: HamadDraftPreview }) {
  const { colors } = useTheme();
  const s = useStyles();
  return (
    <Card style={s.card} testID="hamad-draft-preview">
      <DraftRow draft={draft} />
      <AppText variant="caption" color={colors.muted}>
        {[draft.city, `عدد الصور ${draft.imageCount}`].filter(Boolean).join(" · ")}
      </AppText>
      {!!draft.description && <AppText selectable>{draft.description}</AppText>}
    </Card>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  list: { gap: 8 },
  card: { padding: 10, gap: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  details: { flex: 1, minWidth: 0, gap: 2 },
  thumbnail: { width: 60, height: 60, borderRadius: 10, backgroundColor: colors.primarySoft },
  placeholder: { alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.72 },
}));
