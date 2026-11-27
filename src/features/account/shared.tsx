import React, { useMemo } from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import { SystemAlert as Alert, showFeedbackError } from "../../ui/feedback";
import { router, usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { assetUrl } from "../../core/api";
import { userMessage } from "../../core/errors";
import { AppText, Button, Card, EmptyState, Icon } from "../../ui";
import { createThemedStyles, useTheme } from "../../ui/theme-context";

export function useAccountPalette() {
  const { colors } = useTheme();
  return {
    primary: colors.primary,
    primaryFill: colors.primaryFill,
    onPrimary: colors.onPrimary,
    ink: colors.text,
    muted: colors.muted,
    border: colors.border,
    background: colors.background,
    surface: colors.surface,
    danger: colors.danger,
    dangerSoft: colors.dangerSoft,
    soft: colors.primarySoft,
    green: colors.success,
    subtle: colors.subtle,
  };
}

export function GuestState({
  title = "سجّل الدخول إلى حسابك",
  message = "لإدارة إعلاناتك ومحادثاتك والمفضلة.",
}: {
  title?: string;
  message?: string;
}) {
  return (
    <EmptyState
      icon="person-outline"
      title={title}
      message={message}
      action={
        <Button
          title="تسجيل الدخول"
          onPress={() => router.push("/auth")}
          icon="log-in-outline"
        />
      }
    />
  );
}

export function ErrorState({
  error,
  retry,
}: {
  error?: unknown;
  retry: () => void;
}) {
  return (
    <EmptyState
      icon="cloud-offline-outline"
      title="تعذر تحميل البيانات"
      message={userMessage(error, "تعذّر تحميل البيانات. حاول مرة أخرى.")}
      action={
        <Button
          title="إعادة المحاولة"
          onPress={retry}
          variant="secondary"
          icon="refresh-outline"
        />
      }
    />
  );
}

export function showError(error: unknown, title = "تعذر إكمال الطلب") {
  showFeedbackError(error, title === "تعذر إكمال الطلب" ? "تعذّر إكمال الطلب. حاول مرة أخرى." : title);
}

export function confirmAction(
  title: string,
  message: string,
  onConfirm: () => void,
  label = "تأكيد",
  destructive = false,
) {
  Alert.alert(title, message, [
    { text: "إلغاء", style: "cancel" },
    {
      text: label,
      style: destructive ? "destructive" : "default",
      onPress: onConfirm,
    },
  ]);
}

export function formatDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString("ar-SA", { day: "numeric", month: "short" });
}

export function money(value?: number | null) {
  return value == null
    ? "لم تُحدد"
    : `${new Intl.NumberFormat("ar-SA", { maximumFractionDigits: 2 }).format(value)} ر.س`;
}

export function Avatar({
  name,
  picture,
  size = 48,
}: {
  name?: string;
  picture?: string;
  size?: number;
}) {
  const palette = useAccountPalette();
  const styles = useAccountStyles();
  const uri = assetUrl(picture);
  return uri ? (
    <Image
      source={{ uri }}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: palette.soft,
      }}
    />
  ) : (
    <View
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: size / 2 },
      ]}
    >
      <AppText variant="heading" color={palette.primary}>
        {name?.trim().charAt(0) || "ح"}
      </AppText>
    </View>
  );
}

export function MenuRow({
  title,
  subtitle,
  icon,
  onPress,
  danger = false,
}: {
  title: string;
  subtitle?: string;
  icon: React.ComponentProps<typeof Icon>["name"];
  onPress: () => void;
  danger?: boolean;
}) {
  const palette = useAccountPalette();
  const styles = useAccountStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={({ pressed }) => [styles.menuRow, pressed && { opacity: 0.65 }]}
    >
      <View style={[styles.menuIcon, danger && { backgroundColor: palette.dangerSoft }]}>
        <Icon
          name={icon}
          size={19}
          color={danger ? palette.danger : palette.primary}
        />
      </View>
      <View style={styles.grow}>
        <AppText variant="label" color={danger ? palette.danger : palette.ink}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText variant="caption" color={palette.muted}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
      <Icon name="chevron-back" size={17} color={palette.muted} />
    </Pressable>
  );
}

export function SectionLabel({ children }: { children: string }) {
  const palette = useAccountPalette();
  const styles = useAccountStyles();
  return (
    <AppText
      variant="caption"
      color={palette.muted}
      style={styles.sectionLabel}
    >
      {children}
    </AppText>
  );
}
export function Notice({ children }: { children: string }) {
  const palette = useAccountPalette();
  const styles = useAccountStyles();
  return (
    <Card style={styles.notice}>
      <Icon
        name="information-circle-outline"
        size={20}
        color={palette.primary}
      />
      <AppText style={styles.grow} color={palette.ink}>
        {children}
      </AppText>
    </Card>
  );
}

export function useAccountStyles() {
  const styles = useBaseAccountStyles();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const paddingBottom = ["/account", "/favorites", "/messages"].includes(pathname) ? 112 + insets.bottom : 24;
  return useMemo(() => ({
    ...styles,
    content: StyleSheet.flatten([styles.content, { paddingBottom }]),
    listContent: StyleSheet.flatten([styles.listContent, { paddingBottom }]),
  }), [paddingBottom, styles]);
}

const useBaseAccountStyles = createThemedStyles((colors) => StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  row: { flexDirection: "row-reverse", alignItems: "center", gap: 10 },
  between: {
    flexDirection: "row-reverse",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  stack: { gap: 10 },
  content: { paddingHorizontal: 12, paddingBottom: 24, gap: 12 },
  listContent: {
    paddingHorizontal: 12,
    paddingBottom: 24,
    gap: 8,
    flexGrow: 1,
  },
  avatar: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  menuRow: {
    flexDirection: "row-reverse",
    alignItems: "center",
    minHeight: 48,
    paddingVertical: 7,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  menuIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primarySoft,
  },
  sectionLabel: { marginTop: 2, marginBottom: 6 },
  notice: {
    flexDirection: "row-reverse",
    gap: 10,
    backgroundColor: colors.primarySoft,
    alignItems: "flex-start",
  },
  divider: { height: 1, backgroundColor: colors.border },
}));
