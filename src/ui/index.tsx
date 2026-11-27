import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type TextProps,
  type ViewProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useRef, type ComponentProps, type ReactNode } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { assetUrl } from "../core/api";
import { useBootstrap } from "../core/bootstrap";
import { formatRelativeListingTime } from "../core/presentation";
import { getListingCardImageSources } from "../core/listing-image-sources";
import type { Listing } from "../core/types";
import { fonts, radius } from "./theme";
import { createThemedStyles, useTheme } from "./theme-context";
import { FeedbackHost } from "./feedback";
import { ListingCardImage } from "./listing-card-image";
import { ListingNoPhoto, ListingPhotoPlaceholder } from "./listing-no-photo";
export { colors, fonts, radius, spacing } from "./theme";
export { createThemedStyles, useTheme } from "./theme-context";
export type IconName = ComponentProps<typeof Ionicons>["name"];
export function Icon({
  name,
  size = 22,
  color,
}: {
  name: IconName;
  size?: number;
  color?: string;
}) {
  const { colors } = useTheme();
  return <Ionicons name={name} size={size} color={color ?? colors.text} />;
}
export function AppText({
  variant = "body",
  color,
  style,
  ...props
}: TextProps & {
  variant?: "title" | "heading" | "body" | "caption" | "label";
  color?: string;
}) {
  const s = useStyles();
  return (
    <Text
      {...props}
      style={[s.text, s[variant], color ? { color } : undefined, style]}
    />
  );
}
export function Screen({
  children,
  scroll = false,
  style,
  feedbackModal = false,
}: {
  children: ReactNode;
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
  feedbackModal?: boolean;
}) {
  const s = useStyles();
  return (
    <SafeAreaView edges={["top", "left", "right"]} style={[s.screen, style]}>
      {scroll ? (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={s.content}
        >
          {children}
        </ScrollView>
      ) : (
        children
      )}
      <FeedbackHost modal={feedbackModal} />
    </SafeAreaView>
  );
}
export function Card({ style, ...props }: ViewProps) {
  const s = useStyles();
  return <View {...props} style={[s.card, style]} />;
}
export function Button({
  title,
  onPress,
  variant = "primary",
  loading,
  disabled,
  icon,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  loading?: boolean;
  disabled?: boolean;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const s = useStyles();
  const dark = variant === "primary" || variant === "danger";
  const color = dark
    ? colors.onPrimary
    : variant === "ghost"
      ? colors.muted
      : colors.primary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        variant === "primary"
          ? s.primary
          : variant === "danger"
            ? s.danger
            : variant === "secondary"
              ? s.secondary
              : s.ghost,
        disabled || loading ? s.disabled : undefined,
        pressed ? { opacity: 0.82, transform: [{ scale: 0.985 }] } : undefined,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={color} />
      ) : (
        <>
          {icon ? <Icon name={icon} color={color} size={19} /> : null}
          <AppText variant="label" color={color}>
            {title}
          </AppText>
        </>
      )}
    </Pressable>
  );
}
export function Field({
  label,
  style,
  ...props
}: TextInputProps & { label?: string }) {
  const { colors, scheme } = useTheme();
  const s = useStyles();
  return (
    <View style={s.fieldWrap}>
      {label ? <AppText variant="label">{label}</AppText> : null}
      <TextInput
        placeholderTextColor={colors.muted}
        selectionColor={colors.primary}
        keyboardAppearance={scheme}
        {...props}
        style={[
          s.field,
          props.multiline
            ? { minHeight: 112, textAlignVertical: "top" }
            : undefined,
          style,
        ]}
      />
    </View>
  );
}
export function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
}) {
  const { colors } = useTheme();
  const s = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      onPress={onPress}
      style={[s.chip, active ? s.activeChip : undefined]}
    >
      <AppText
        variant="caption"
        color={active ? colors.onPrimary : colors.muted}
        style={active ? { fontFamily: fonts.bold } : undefined}
      >
        {label}
      </AppText>
    </Pressable>
  );
}
export function PageHeader({
  title,
  subtitle,
  back,
  right,
}: {
  title: string;
  subtitle?: string;
  back?: boolean;
  right?: ReactNode;
}) {
  const s = useStyles();
  return (
    <View style={s.pageHeader}>
      <View style={s.headerTitle}>
        {back ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="رجوع"
            onPress={() =>
              router.canGoBack() ? router.back() : router.replace("/")
            }
            style={s.iconButton}
          >
            <Icon name="arrow-forward" />
          </Pressable>
        ) : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText variant="heading" numberOfLines={1} style={s.pageTitle}>{title}</AppText>
          {subtitle ? <AppText variant="caption">{subtitle}</AppText> : null}
        </View>
      </View>
      {right}
    </View>
  );
}
export function EmptyState({
  title,
  message,
  icon = "file-tray-outline",
  action,
}: {
  title: string;
  message?: string;
  icon?: IconName;
  action?: ReactNode;
}) {
  const { colors } = useTheme();
  const s = useStyles();
  return (
    <View style={s.empty}>
      <View style={s.emptyIcon}>
        <Icon name={icon} size={24} color={colors.primary} />
      </View>
      <AppText variant="label" style={{ textAlign: "center" }}>{title}</AppText>
      {message ? (
        <AppText
          variant="caption"
          color={colors.muted}
          style={{ textAlign: "center", maxWidth: 330 }}
        >
          {message}
        </AppText>
      ) : null}
      {action ? (
        <View style={{ marginTop: 2, alignSelf: "stretch" }}>{action}</View>
      ) : null}
    </View>
  );
}
export function LoadingState() {
  const { colors } = useTheme();
  const s = useStyles();
  return (
    <View style={s.loading}>
      <ActivityIndicator color={colors.primary} />
      <AppText variant="caption">جارٍ التحميل…</AppText>
    </View>
  );
}
export function InlineNotice({
  message,
  onRetry,
  busy = false,
}: {
  message: string;
  onRetry?: () => void;
  busy?: boolean;
}) {
  const { colors } = useTheme();
  const s = useStyles();
  return <View style={s.inlineNotice} accessibilityLiveRegion="polite">
    <Icon name="information-circle-outline" size={18} color={colors.primary} />
    <AppText variant="caption" style={{ flex: 1, minWidth: 0 }}>{message}</AppText>
    {onRetry ? <Pressable
      accessibilityRole="button"
      accessibilityLabel="إعادة المحاولة"
      accessibilityState={{ disabled: busy, busy }}
      disabled={busy}
      onPress={onRetry}
      style={s.inlineRetry}
    >{busy ? <ActivityIndicator size="small" color={colors.primary} /> : <Icon name="refresh-outline" size={19} color={colors.primary} />}</Pressable> : null}
  </View>;
}
export type ActionMenuItem = {
  label: string;
  icon?: IconName;
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
};
export function ActionMenu({
  visible,
  title,
  items,
  onClose,
}: {
  visible: boolean;
  title: string;
  items: ActionMenuItem[];
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const s = useStyles();
  // Present iOS confirmation alerts after the native modal has dismissed.
  const pendingAction = useRef<(() => void) | undefined>(undefined);
  const finishDismissal = () => {
    const action = pendingAction.current;
    pendingAction.current = undefined;
    action?.();
  };
  return <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose} onDismiss={finishDismissal}>
    <View style={s.menuOverlay}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="إغلاق الخيارات" />
      <SafeAreaView edges={["bottom", "left", "right"]} style={s.menuSheet} accessibilityViewIsModal>
        <View style={s.menuHeading}>
          <AppText variant="label" numberOfLines={2} style={{ flex: 1, minWidth: 0 }}>{title}</AppText>
          <Pressable accessibilityRole="button" accessibilityLabel="إغلاق الخيارات" onPress={onClose} style={s.inlineRetry}><Icon name="close" size={21} /></Pressable>
        </View>
        <ScrollView bounces={false} style={{ flexGrow: 0 }}>
          {items.map(item => <Pressable
            key={item.label}
            accessibilityRole="button"
            accessibilityLabel={item.label}
            accessibilityState={{ disabled: !!item.disabled }}
            disabled={item.disabled}
            style={({ pressed }) => [s.menuItem, item.disabled && s.disabled, pressed && { opacity: 0.7 }]}
            onPress={() => {
              if (Platform.OS === "ios") pendingAction.current = item.onPress;
              onClose();
              if (Platform.OS !== "ios") item.onPress();
            }}
          >
            {item.icon ? <Icon name={item.icon} size={21} color={item.destructive ? colors.danger : colors.text} /> : null}
            <AppText color={item.destructive ? colors.danger : colors.text} style={{ flexShrink: 1 }}>{item.label}</AppText>
          </Pressable>)}
        </ScrollView>
      </SafeAreaView>
    </View>
  </Modal>;
}
export function formatPrice(price: Listing["price"]) {
  return typeof price === "number"
    ? `${new Intl.NumberFormat("ar-SA").format(price)} ر.س`
    : price === "bid"
      ? "على السوم"
      : price === "negotiable"
        ? "قابل للتفاوض"
        : "السعر لدى المعلن";
}
export function ListingCard({
  listing,
  onPress,
  statusLabel,
  onMenuPress,
  localPreviewUri,
  imageAbsenceKnown = false,
  cacheDrawing = false,
}: {
  listing: Listing;
  onPress?: () => void;
  statusLabel?: string;
  onMenuPress?: () => void;
  localPreviewUri?: string;
  imageAbsenceKnown?: boolean;
  cacheDrawing?: boolean;
}) {
  const { colors } = useTheme();
  const s = useStyles();
  const bootstrap = useBootstrap();
  const visibleImages =
    listing.status === "published"
      ? listing.images?.filter((i) => i.status === "approved")
      : listing.images;
  const image = visibleImages?.find((i) => i.isPrimary) || visibleImages?.[0];
  const imageSources = getListingCardImageSources(image, assetUrl);
  if (localPreviewUri && /^(file:|content:|blob:|data:image\/)/i.test(localPreviewUri)) imageSources.unshift(localPreviewUri);
  const noPhoto = imageAbsenceKnown && Array.isArray(listing.images) &&
    listing.images.length === 0 && !localPreviewUri;
  const category = bootstrap.data?.categories.find(item => item.id === listing.category);
  const optionId = listing.attributes?.marketplaceCategoryOption;
  const option = category?.options.find(item => item.id === optionId);
  const modelId = listing.attributes?.marketplaceCarModel;
  const model = typeof optionId === "string"
    ? category?.carModels?.[optionId]?.find(item => item.id === modelId)
    : undefined;
  const categoryLabel = [category?.label, option?.label, model?.label].filter(Boolean).join(" · ");
  const date = listing.createdAt || listing.updatedAt;
  const stats = [
    typeof listing.views === "number" ? `${new Intl.NumberFormat("ar-SA").format(listing.views)} مشاهدة` : undefined,
    typeof listing.messageCount === "number" ? `${new Intl.NumberFormat("ar-SA").format(listing.messageCount)} رسائل` : undefined,
  ].filter(Boolean).join(" · ");
  return (
    <View renderToHardwareTextureAndroid={cacheDrawing && Platform.OS === "android"} style={s.listingWrap}>
    <Pressable
      onPress={
        onPress ||
        (() => router.push(`/listings/${encodeURIComponent(listing.id)}`))
      }
      accessibilityRole="button"
      accessibilityLabel={listing.title || "تفاصيل الإعلان"}
      style={({ pressed }) => [
        s.listing,
        pressed ? { opacity: 0.9 } : undefined,
      ]}
    >
      <View style={s.listingImage}>
        {noPhoto ? <ListingNoPhoto /> : <ListingCardImage
          sources={imageSources}
          fallback={<ListingPhotoPlaceholder
            accessibilityLabel={image || imageSources.length ? "تعذّر تحميل الصورة" : "صورة الإعلان غير متاحة"}
            message={image || imageSources.length ? "تعذّر تحميل الصورة" : "صورة الإعلان غير متاحة"}
          />}
        />}
        {statusLabel ? <View style={[s.listingStatus, listing.status === "published" && s.listingStatusPublished]}><AppText variant="caption" style={[s.listingStatusText, listing.status === "published" && s.listingStatusTextPublished]}>{statusLabel}</AppText></View> : null}
      </View>
      <View style={[s.listingBody, onMenuPress && s.listingBodyWithMenu]}>
        <AppText
          numberOfLines={2}
          variant="label"
          style={s.listingTitle}
        >
          {listing.title || "مسودة إعلان"}
        </AppText>
        <AppText
          style={s.listingPrice}
        >
          {formatPrice(listing.price)}
        </AppText>
        <View style={s.listingMeta}>
          <View style={s.listingMetaItem}><Icon name="time-outline" size={13} color={colors.muted} /><AppText numberOfLines={1} style={s.listingMetaText}>{date ? formatRelativeListingTime(date) : "وقت غير محدد"}</AppText></View>
          <View style={s.listingMetaItem}><Icon name="location-outline" size={13} color={colors.muted} /><AppText numberOfLines={1} style={s.listingMetaText}>{listing.city || "السعودية"}</AppText></View>
        </View>
        {(categoryLabel || stats) ? <View style={s.listingFoot}><AppText numberOfLines={1} style={s.listingCategory}>{categoryLabel}</AppText>{stats ? <AppText numberOfLines={1} style={s.listingStats}>{stats}</AppText> : null}</View> : null}
      </View>
    </Pressable>
    {onMenuPress ? <Pressable
      accessibilityRole="button"
      accessibilityLabel={`خيارات الإعلان: ${listing.title || "مسودة إعلان"}`}
      onPress={onMenuPress}
      style={s.listingMenu}
    ><Icon name="ellipsis-horizontal" size={21} color={colors.muted} /></Pressable> : null}
    </View>
  );
}
const useStyles = createThemedStyles((colors) => StyleSheet.create({
  // Rows already express the Arabic design explicitly with row-reverse.
  // Keep Yoga's coordinate direction stable across device locales; text keeps
  // its own RTL writing direction below.
  screen: { flex: 1, backgroundColor: colors.background, direction: "ltr" },
  content: { padding: 12, gap: 12, paddingBottom: 24 },
  text: {
    fontFamily: fonts.regular,
    color: colors.text,
    textAlign: "right",
    writingDirection: "rtl",
    fontSize: 14,
    lineHeight: 23,
  },
  title: { fontSize: 30, lineHeight: 44, fontFamily: fonts.bold },
  heading: { fontSize: 20, lineHeight: 30, fontFamily: fonts.bold },
  body: { fontSize: 14, lineHeight: 24 },
  caption: { fontSize: 12, lineHeight: 20, color: colors.muted },
  label: { fontSize: 14, lineHeight: 23, fontFamily: fonts.bold },
  card: {
    padding: 12,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 10,
  },
  button: {
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.md,
    flexDirection: "row-reverse",
    gap: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  primary: { backgroundColor: colors.primaryFill },
  danger: { backgroundColor: colors.dangerFill },
  secondary: { backgroundColor: colors.primarySoft },
  ghost: { backgroundColor: "transparent" },
  disabled: { opacity: 0.5 },
  fieldWrap: { gap: 8 },
  field: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 16,
    paddingVertical: 13,
    minHeight: 50,
    fontFamily: fonts.regular,
    color: colors.text,
    textAlign: "right",
    writingDirection: "rtl",
    fontSize: 14,
  },
  chip: {
    minHeight: 44,
    justifyContent: "center",
    paddingVertical: 8,
    paddingHorizontal: 13,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  activeChip: { backgroundColor: colors.primaryFill, borderColor: colors.primaryFill },
  pageHeader: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    flexDirection: "row-reverse",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  pageTitle: { fontSize: 18, lineHeight: 28 },
  headerTitle: {
    flex: 1,
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 12,
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  empty: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    paddingVertical: 20,
    gap: 8,
  },
  emptyIcon: {
    height: 44,
    width: 44,
    borderRadius: 14,
    backgroundColor: colors.primarySoft,
    alignItems: "center",
    justifyContent: "center",
  },
  loading: {
    minHeight: 104,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  inlineNotice: { flexDirection: "row-reverse", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, backgroundColor: colors.primarySoft },
  inlineRetry: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  menuOverlay: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay, direction: "ltr" },
  menuSheet: { maxHeight: "75%", paddingHorizontal: 12, paddingBottom: 8, borderTopLeftRadius: 16, borderTopRightRadius: 16, backgroundColor: colors.surface },
  menuHeading: { flexDirection: "row-reverse", alignItems: "center", gap: 8, paddingTop: 6 },
  menuItem: { minHeight: 48, paddingHorizontal: 8, paddingVertical: 10, flexDirection: "row-reverse", alignItems: "center", gap: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  listingWrap: { position: "relative" },
  listingMenu: { position: "absolute", left: 0, top: 0, width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  listingBodyWithMenu: { paddingLeft: 44 },
  listingStatus: { position: "absolute", bottom: 4, right: 4, left: 4, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4, backgroundColor: colors.surface },
  listingStatusPublished: { backgroundColor: colors.primaryFill },
  listingStatusText: { fontSize: 10, lineHeight: 18, color: colors.text, textAlign: "center" },
  listingStatusTextPublished: { color: colors.onPrimary },
  listing: {
    width: "100%",
    minHeight: 100,
    // Keep the explicitly reversed Arabic row stable inside any RTL parent.
    direction: "ltr",
    flexDirection: "row-reverse",
    backgroundColor: colors.surface,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
    minWidth: 0,
    boxShadow: `0px 3px 10px ${colors.shadow}14`,
  },
  listingImage: {
    width: 100,
    minHeight: 100,
    alignSelf: "stretch",
    backgroundColor: colors.imageBackground,
    alignItems: "center",
    justifyContent: "center",
  },
  listingBody: { flex: 1, minWidth: 0, paddingHorizontal: 8, paddingVertical: 6, gap: 2, justifyContent: "space-between" },
  listingTitle: { color: colors.primary, fontSize: 13, lineHeight: 20, fontFamily: fonts.bold },
  listingPrice: { color: colors.text, fontSize: 15, lineHeight: 24, fontFamily: fonts.bold },
  listingMeta: { flexDirection: "row-reverse", gap: 8, alignItems: "center" },
  listingMetaItem: { flexDirection: "row-reverse", gap: 3, alignItems: "center", flexShrink: 1, minWidth: 0 },
  listingMetaText: { fontSize: 10, lineHeight: 18, color: colors.muted, flexShrink: 1 },
  listingFoot: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center", gap: 6 },
  listingCategory: { fontSize: 10, lineHeight: 18, color: colors.muted, flexShrink: 1, minWidth: 0 },
  listingStats: { fontSize: 9, lineHeight: 18, color: colors.muted, flexShrink: 1, minWidth: 0 },
}));
