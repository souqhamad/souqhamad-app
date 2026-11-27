import { ListingCardRecoveryProvider } from "../../ui/listing-card-recovery";
import { useActionMutation as useMutation } from "../../ui/action-mutation";
import { useFeedback } from "../../ui/feedback";
import { createThemedStyles, useTheme } from "../../ui/theme-context";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { FlatList, I18nManager, Linking, Modal, Pressable, Share, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, router } from "expo-router";
import { Image } from "expo-image";
import {
  GestureDetector,
  GestureHandlerRootView,
  useNativeGesture,
} from "react-native-gesture-handler";
import { useQueryClient } from "@tanstack/react-query";
import { useVisibleQuery as useQuery } from "../../core/visible-query";
import * as Crypto from "expo-crypto";
import { api, assetUrl, getApiBaseUrl } from "../../core/api";
import { useAuth } from "../../core/auth";
import { useBootstrap } from "../../core/bootstrap";
import { userMessage } from "../../core/errors";
import { getListingImageSources } from "../../core/listing-image-sources";
import { ListingPhotoPlaceholder } from "../../ui/listing-no-photo";
import { parseSimilarListings } from "../../core/similar-listings";
import {
  formatAttributeLabel,
  formatAttributeValue,
} from "../../core/presentation";
import type { Listing, ListingImage } from "../../core/types";
import {
  AppText,
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  LoadingState,
  ListingCard,
  PageHeader,
  Screen,
  fonts,
  formatPrice,
} from "../../ui";
import { GalleryPreviewProvider, ProgressiveListingImage, ZoomableGalleryImage } from "../../ui/zoomable-gallery-image";
import { getGalleryNeighbourIndexes, resolveGallerySelection } from "../../ui/gallery-geometry";
import { useWarmGalleryPreviews } from "../../ui/gallery-preview-context";
import { listingPhotoGap, listingPhotoHeight } from "../../ui/listing-photo-window";
import { useListingPhotoWindow } from "../../ui/use-listing-photo-window";
type SimilarFollowState = {
  status: "ok" | "followed" | "unfollowed";
  isFollowing: boolean;
  canFollow: boolean;
};

function ListingGallery({
  images,
  initialIndex,
  onIndexChange,
  onClose,
}: {
  images: ListingImage[];
  initialIndex: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const s = useStyles();
  const insets = useSafeAreaInsets();

  const pager = useRef<FlatList<ListingImage>>(null);
  const scrollGesture = useNativeGesture();
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [selection, setSelection] = useState(() => resolveGallerySelection(images, { index: initialIndex }));
  const selected = resolveGallerySelection(images, selection);
  if (selected !== selection) setSelection(selected);
  const activeIndex = selected.index;
  const currentIndex = useRef(activeIndex);
  const currentImages = useRef(images);
  const needsAlignment = useRef(true);
  const pagerKey = `${viewport.width}:${JSON.stringify(images.map(image => image.id))}`;
  useLayoutEffect(() => {
    currentImages.current = images;
    currentIndex.current = selected.index;
  }, [images, selected]);
  useLayoutEffect(() => { needsAlignment.current = true; }, [pagerKey]);
  const onVisiblePageChanged = useCallback(({ viewableItems }: { viewableItems: { isViewable: boolean; index?: number | null; item?: ListingImage }[] }) => {
    const next = viewableItems.find(item => item.isViewable);
    if (!next || next.index === null || next.index === undefined) return;
    const nextIndex = next.index;
    const photo = currentImages.current[nextIndex];
    if (!photo || (next.item && next.item.id !== photo.id)) return;
    if (needsAlignment.current && nextIndex !== currentIndex.current) return;
    needsAlignment.current = false;
    currentIndex.current = nextIndex;
    setSelection(current => current.id === photo.id && current.index === nextIndex ? current : { id: photo.id, index: nextIndex });
    onIndexChange(nextIndex);
  }, [onIndexChange]);
  const [viewabilityConfig] = useState(() => ({ itemVisiblePercentThreshold: 60, minimumViewTime: 80 }));
  const previewOrder = [activeIndex, ...getGalleryNeighbourIndexes(activeIndex, images.length), ...images.map((_, i) => i)];
  useWarmGalleryPreviews([...new Set(previewOrder)].map(i => {
    const photo = images[i];
    if (!photo) return undefined;
    const display = assetUrl(photo.displayUrl);
    const thumbnail = assetUrl(photo.thumbnailUrl);
    const original = assetUrl(photo.originalUrl);
    // New records alias originalUrl to the known display derivative. Legacy
    // original-only aliases remain visible-page loads rather than warm-ups.
    if (display && (display !== original || /-display\.webp(?:[?#]|$)/i.test(display))) return display;
    return thumbnail && thumbnail !== original ? thumbnail : undefined;
  }).filter((url): url is string => !!url));

  return <View style={[s.gallery, {
    paddingTop: insets.top + 60,
    paddingBottom: insets.bottom + 76,
    paddingLeft: insets.left,
    paddingRight: insets.right,
  }]}>
    <View style={{ flex: 1 }} onLayout={({ nativeEvent: { layout } }) => {
      if (layout.width !== viewport.width || layout.height !== viewport.height) {
        // A height-only modal/inset update does not change horizontal pages.
        // Re-arming here would wait for a content-size event that may not recur.
        if (layout.width !== viewport.width) needsAlignment.current = true;
        setViewport({ width: layout.width, height: layout.height });
      }
    }}>
      {viewport.width > 0 && viewport.height > 0 ? <GestureDetector gesture={scrollGesture}>
        <FlatList
          key={pagerKey}
          ref={pager}
          data={images}
          keyExtractor={(photo) => photo.id}
          extraData={activeIndex}
          onViewableItemsChanged={onVisiblePageChanged}
          viewabilityConfig={viewabilityConfig}
          onScrollBeginDrag={() => { needsAlignment.current = false; }}
          horizontal
          pagingEnabled
          directionalLockEnabled
          decelerationRate="fast"
          bounces={false}
          showsHorizontalScrollIndicator={false}
          style={{ direction: I18nManager.isRTL ? "rtl" : "ltr" }}
          contentContainerStyle={{ direction: I18nManager.isRTL ? "rtl" : "ltr" }}
          initialScrollIndex={activeIndex}
          getItemLayout={(_, i) => ({ length: viewport.width, offset: viewport.width * i, index: i })}
          initialNumToRender={Math.min(3, images.length)}
          maxToRenderPerBatch={3}
          windowSize={3}
          removeClippedSubviews={false}
          onContentSizeChange={() => {
            if (!needsAlignment.current) return;
            pager.current?.scrollToOffset({ offset: viewport.width * currentIndex.current, animated: false });
            needsAlignment.current = false;
          }}
          onScrollToIndexFailed={() => {
            pager.current?.scrollToOffset({ offset: viewport.width * currentIndex.current, animated: false });
          }}
          renderItem={({ item: photo, index: i }) => <ZoomableGalleryImage
            {...getListingImageSources(photo, assetUrl)}
            width={viewport.width}
            height={viewport.height}
            active={i === activeIndex}
            scrollGesture={scrollGesture}
            accessibilityLabel={`صورة الإعلان ${i + 1} من ${images.length}`}
          />}
        />
      </GestureDetector> : null}
    </View>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="إغلاق الصور"
      style={[s.close, { top: insets.top + 10, right: insets.right + 16 }]}
      onPress={onClose}
    ><Icon name="close" color="white" size={28} /></Pressable>
    <View style={[s.galleryFooter, { bottom: insets.bottom + 12 }]} pointerEvents="none">
      <AppText style={s.galleryCounter}>{`${activeIndex + 1} من ${images.length}`}</AppText>
      <AppText style={s.galleryHint}>اسحب بين الصور · قرّب إصبعين أو انقر مرتين للتكبير</AppText>
    </View>
  </View>;
}

export default function ListingScreen() {
  const feedback = useFeedback();
  const { colors } = useTheme();
  const s = useStyles();
  const { listingId } = useLocalSearchParams<{ listingId: string }>();
  const { user } = useAuth();
  const bootstrap = useBootstrap();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const [index, setIndex] = useState(0);
  const [gallery, setGallery] = useState(false);
  const [report, setReport] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const followScope = `${user?.id || "guest"}:${listingId}`;
  const currentFollowScope = useRef(followScope);
  useLayoutEffect(() => {
    currentFollowScope.current = followScope;
  }, [followScope]);
  const [followNotice, setFollowNotice] = useState<{
    scope: string;
    text: string;
    failed?: boolean;
  } | null>(null);
  const path = `/api/marketplace/listings/${encodeURIComponent(listingId || "")}`;
  const [visitId] = useState(() => Crypto.randomUUID());
  const listing = useQuery({
    queryKey: ["listing", listingId, visitId],
    queryFn: ({ signal }) => api.get<{ listing: Listing }>(path, { visit: visitId }, { signal }),
    enabled: !!listingId,
  });
  const similar = useQuery({
    queryKey: ["listing", listingId, "similar"],
    queryFn: async ({ signal }) => parseSimilarListings(
      await api.get<unknown>(path, { view: "similar" }, { signal }),
      listingId,
    ),
    enabled: !!listingId && listing.data?.listing.status === "published",
  });
  const images = (listing.data?.listing.images || []).filter(photo => photo.status === "approved");
  const photoWindow = useListingPhotoWindow(images.length, listingId);
  const saved = useQuery({
    queryKey: ["favorite", user?.id, listingId],
    queryFn: ({ signal }) =>
      api.get<{
        favorited?: boolean;
        favorite?: boolean;
        isFavorite?: boolean;
      }>(`${path}/favorite`, undefined, { signal }),
    enabled: !!user,
  });
  const similarFollow = useQuery({
    queryKey: ["account", user?.id, "similar-follow", listingId],
    queryFn: ({ signal }) =>
      api.get<SimilarFollowState>(`${path}/similar-follow`, undefined, { signal }),
    enabled:
      !!user &&
      !!listingId &&
      listing.data?.listing.status === "published" &&
      listing.data.listing.sellerId !== user.id,
  });
  const follow = useMutation({
    mutationFn: (input: { userId: string; listingId: string }) =>
      api.post<SimilarFollowState>(
        `/api/marketplace/listings/${encodeURIComponent(input.listingId)}/similar-follow`,
        undefined,
        { idempotencyKey: Crypto.randomUUID() },
      ),
    onSuccess: (result, input) => {
      const scope = `${input.userId}:${input.listingId}`;
      if (scope !== currentFollowScope.current) return;
      qc.setQueryData(
        ["account", input.userId, "similar-follow", input.listingId],
        result,
      );
      void qc.invalidateQueries({
        queryKey: ["account", input.userId, "follows"],
      });
      setFollowNotice({
        scope,
        text: result.isFollowing
          ? "سيصلك تنبيه عند نشر إعلان مشابه بدرجة قوية."
          : "تم إيقاف متابعة الإعلانات المشابهة.",
      });
    },
    onError: (_error, input) => {
      const scope = `${input.userId}:${input.listingId}`;
      if (scope !== currentFollowScope.current) return;
      setFollowNotice({
        scope,
        failed: true,
        text: "تعذر تحديث متابعة الإعلانات المشابهة الآن.",
      });
      // A disconnected response may still have changed the server state.
      void similarFollow.refetch();
    },
  });
  const seller = useQuery({
    queryKey: ["seller", listing.data?.listing.sellerId, "summary"],
    queryFn: ({ signal }) =>
      api.get<{
        seller: {
          id: string;
          name: string;
          picture?: string;
          ratingAverage: number;
          ratingCount: number;
          followerCount: number;
        };
      }>(
        `/api/marketplace/users/${encodeURIComponent(listing.data!.listing.sellerId)}/profile?summary=1`,
        undefined, { signal },
      ),
    enabled: !!listing.data?.listing.sellerId,
  });
  const favorite = useMutation({
    mutationFn: () =>
      api.post<{ isFavorite: boolean }>(`${path}/favorite`, undefined, {
        idempotencyKey: Crypto.randomUUID(),
      }),
    onSuccess: result => {
      if (typeof result.isFavorite === "boolean") feedback.success(result.isFavorite ? "أُضيف الإعلان للمفضلة" : "أُزيل الإعلان من المفضلة");
      void saved.refetch();
      void qc.invalidateQueries({
        queryKey: ["account", user?.id, "favorites"],
      });
    },
    onError: e => feedback.error(e, "تعذّر حفظ الإعلان. حاول مجددًا."),
  });
  const message = useMutation({
    mutationFn: () =>
      api.post<{ conversation: { id: string } }>(
        "/api/marketplace/conversations",
        { listingId },
        { idempotencyKey: Crypto.randomUUID() },
      ),
    onSuccess: (result) =>
      router.push(
        `/conversations/${encodeURIComponent(result.conversation.id)}`,
      ),
    onError: e => feedback.error(e, "تعذّر بدء المحادثة. حاول مجددًا."),
  });
  function requireUser(action: () => void) {
    if (!user) router.push("/auth");
    else action();
  }
  async function contact() {
    try {
      const result = await api.get<{ phoneNumber: string | null }>(
        `${path}/contact`,
      );
      if (!result.phoneNumber) {
        feedback.info("لم يضف المعلن رقمًا للتواصل. يمكنك مراسلته داخل السوق.");
        return;
      }
      await Linking.openURL(`tel:${result.phoneNumber}`);
    } catch (e) {
      feedback.error(e, "تعذّر الاتصال الآن. حاول مجددًا.");
    }
  }
  async function sendReport() {
    if (reason.trim().length < 2) {
      setError("اكتب سبب البلاغ.");
      return;
    }
    try {
      await api.post(
        `${path}/reports`,
        { reason: "other", details: reason.trim() },
        { idempotencyKey: Crypto.randomUUID() },
      );
      setReport(false);
      setReason("");
      feedback.success("تم إرسال البلاغ للإدارة");
    } catch (e) {
      setError(userMessage(e, "تعذّر إرسال البلاغ. حاول مجددًا."));
    }
  }
  if (listing.isPending)
    return (
      <Screen>
        <PageHeader title="تفاصيل الإعلان" back />
        <LoadingState />
      </Screen>
    );
  if (listing.isError || !listing.data)
    return (
      <Screen>
        <PageHeader title="تفاصيل الإعلان" back />
        <EmptyState
          title="الإعلان غير متاح"
          message={userMessage(listing.error, "تعذّر تحميل الإعلان. أعد المحاولة.")}
          action={
            <Button
              title="إعادة المحاولة"
              onPress={() => void listing.refetch()}
            />
          }
        />
      </Screen>
    );
  const item = listing.data.listing;
  const own = item.sellerId === user?.id;
  const category =
    bootstrap.data?.categories.find((c) => c.id === item.category)?.label ||
    item.category;
  const favorited = !!(
    saved.data?.favorited ||
    saved.data?.favorite ||
    saved.data?.isFavorite
  );
  return (
    <ListingCardRecoveryProvider revision={similar.dataUpdatedAt}><GalleryPreviewProvider key={listingId}>
    <Screen>
        <PageHeader
          title="تفاصيل الإعلان"
          back
          right={
            <View style={{ flexDirection: "row", gap: 16 }}>
              <Pressable
                accessibilityLabel="مشاركة الإعلان"
                onPress={() =>
                  void Share.share({
                    title: item.title,
                    message: `${item.title || "إعلان في سوق حمد"}\n${getApiBaseUrl()}/listings/${encodeURIComponent(item.id)}`,
                  }).then(result => {
                    if (result.action === Share.sharedAction) feedback.info("تمت مشاركة الإعلان");
                  }).catch(e => feedback.error(e, "تعذّرت مشاركة الإعلان. حاول مجددًا."))
                }
              >
                <Icon name="share-outline" />
              </Pressable>
              <Pressable
                accessibilityLabel="حفظ في المفضلة"
                onPress={() => requireUser(() => favorite.mutate())}
              >
                <Icon
                  name={favorited ? "heart" : "heart-outline"}
                  color={favorited ? colors.danger : colors.text}
                />
              </Pressable>
            </View>
          }
        />
      <FlatList
        key={listingId}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 110 + insets.bottom }}
        onLayout={photoWindow.onViewportLayout}
        onScroll={photoWindow.onScroll}
        scrollEventThrottle={48}
        data={item.status === "published" ? similar.data || [] : []}
        keyExtractor={candidate => candidate.id}
        initialNumToRender={3}
        maxToRenderPerBatch={4}
        windowSize={5}
        removeClippedSubviews={false}
        renderItem={({ item: candidate }) => (
          <View style={s.similarRow}><ListingCard listing={candidate} /></View>
        )}
        ListHeaderComponent={
        <View style={s.content}>
          <View style={{ gap: 8 }}>
            <AppText variant="title" style={{ fontSize: 25, lineHeight: 37 }}>
              {item.title}
            </AppText>
            <AppText
              color={colors.primary}
              style={{ fontFamily: fonts.bold, fontSize: 26, lineHeight: 40 }}
            >
              {formatPrice(item.price)}
            </AppText>
            <View style={s.meta}>
              <AppText variant="caption">{category}</AppText>
              <View style={s.metaItem}>
                <Icon name="location-outline" size={16} color={colors.muted} />
                <AppText variant="caption">{item.city || "السعودية"}</AppText>
              </View>
              {item.createdAt ? (
                <View style={s.metaItem}>
                  <Icon name="time-outline" size={15} color={colors.muted} />
                  <AppText variant="caption">
                    {new Date(item.createdAt).toLocaleDateString("ar-SA")}
                  </AppText>
                </View>
              ) : null}
            </View>
          </View>
          <Card>
            <AppText variant="heading" style={{ fontSize: 17 }}>
              عن الإعلان
            </AppText>
            <AppText style={{ lineHeight: 29 }}>
              {item.description || "لم يضف المعلن وصفًا."}
            </AppText>
            {item.condition ? (
              <View style={s.attribute}>
                <AppText variant="caption">الحالة</AppText>
                <AppText variant="label">
                  {
                    {
                      new: "جديد",
                      used: "مستعمل",
                      like_new: "شبه جديد",
                      damaged: "يحتاج إصلاح",
                    }[item.condition]
                  }
                </AppText>
              </View>
            ) : null}
            {Object.entries(item.attributes || {})
              .filter(
                ([key, value]) =>
                  !key.startsWith("_") &&
                  ["string", "number", "boolean"].includes(typeof value),
              )
              .slice(0, 12)
              .map(([key, value]) => (
                <View key={key} style={s.attribute}>
                  <AppText variant="caption">
                    {formatAttributeLabel(key)}
                  </AppText>
                  <AppText variant="label">
                    {key === "marketplaceCategoryOption"
                      ? bootstrap.data?.categories
                          .find((c) => c.id === item.category)
                          ?.options.find((option) => option.id === value)
                          ?.label || "غير محدد"
                      : key === "marketplaceCarModel"
                        ? bootstrap.data?.categories
                            .find((c) => c.id === item.category)
                            ?.carModels?.[
                              String(item.attributes.marketplaceCategoryOption)
                            ]?.find((model) => model.id === value)?.label ||
                          String(value)
                        : formatAttributeValue(key, value)}
                  </AppText>
                </View>
              ))}
          </Card>
          <View style={s.photos} onLayout={photoWindow.onPhotosLayout}>
            {images.length ? images.map((photo, i) => <View key={photo.id} style={s.photoFrame}>
              {i >= photoWindow.range.first && i <= photoWindow.range.last ? <ProgressiveListingImage
                key={`${photo.displayUrl}|${photo.thumbnailUrl}|${photo.originalUrl}`}
                previewSource={getListingImageSources(photo, assetUrl).previewSource}
                thumbnailSource={assetUrl(photo.thumbnailUrl)}
                contentFit="cover"
                accessibilityLabel={`صورة الإعلان ${i + 1} من ${images.length}`}
                renderImage={(layers) => <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`فتح صورة الإعلان ${i + 1} من ${images.length}`}
                  style={StyleSheet.absoluteFill}
                  onPress={() => { setIndex(i); setGallery(true); }}
                >{layers}</Pressable>}
              /> : <Pressable
                accessibilityRole="button"
                accessibilityLabel={`فتح صورة الإعلان ${i + 1} من ${images.length}`}
                style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}
                onPress={() => { setIndex(i); setGallery(true); }}
              ><Icon name="image-outline" size={30} color={colors.muted} /></Pressable>}
              <View pointerEvents="none" style={s.counter}>
                <Icon name="expand-outline" size={14} color="white" />
                <AppText style={{ color: "white", fontSize: 12 }}>{`${i + 1} من ${images.length}`}</AppText>
              </View>
            </View>) : <View style={s.photoFrame}>
              <ListingPhotoPlaceholder accessibilityLabel="صور الإعلان غير متاحة" message="صور الإعلان غير متاحة" />
            </View>}
          </View>
          <Pressable
            onPress={() =>
              router.push(`/sellers/${encodeURIComponent(item.sellerId)}`)
            }
          >
            <Card style={s.seller}>
              <View style={s.avatar}>
                {seller.data?.seller.picture ? (
                  <Image
                    source={assetUrl(seller.data.seller.picture)}
                    style={{ height: 50, width: 50, borderRadius: 18 }}
                  />
                ) : (
                  <Icon name="person-outline" color={colors.primary} />
                )}
              </View>
              <View style={{ flex: 1 }}>
                <AppText variant="label">
                  {seller.data?.seller.name || "المعلن"}
                </AppText>
                <View
                  style={{
                    flexDirection: "row-reverse",
                    alignItems: "center",
                    gap: 5,
                  }}
                >
                  <Icon name="star" size={12} color={colors.warning} />
                  <AppText variant="caption">
                    {seller.data?.seller.ratingAverage?.toFixed(1) || "—"} ·{" "}
                    {seller.data?.seller.ratingCount || 0} تقييم
                  </AppText>
                </View>
              </View>
              <Icon name="chevron-back" size={18} color={colors.muted} />
            </Card>
          </Pressable>
          {!own ? (
            <View style={{ gap: 8 }}>
              <Button
                title={
                  user && similarFollow.isError
                    ? "إعادة تحميل حالة المتابعة"
                    : similarFollow.data?.isFollowing
                      ? "إيقاف متابعة المشابه"
                      : "تابع الإعلانات المشابهة"
                }
                icon={
                  similarFollow.data?.isFollowing
                    ? "notifications-off-outline"
                    : "notifications-outline"
                }
                variant={similarFollow.data?.isFollowing ? "secondary" : "primary"}
                loading={follow.isPending || (!!user && similarFollow.isFetching)}
                disabled={similarFollow.data?.canFollow === false}
                onPress={() => requireUser(() => {
                  if (similarFollow.isError || !similarFollow.data) {
                    void similarFollow.refetch();
                    return;
                  }
                  setFollowNotice(null);
                  follow.mutate({ userId: user!.id, listingId });
                })}
              />
              {followNotice?.scope === followScope ? (
                <AppText
                  variant="caption"
                  accessibilityLiveRegion="polite"
                  color={followNotice.failed ? colors.danger : colors.success}
                >
                  {followNotice.text}
                </AppText>
              ) : null}
            </View>
          ) : null}
          <Button
            title="الإبلاغ عن الإعلان"
            variant="ghost"
            icon="flag-outline"
            onPress={() => requireUser(() => setReport(true))}
          />
          <AppText variant="caption" style={{ textAlign: "center" }}>
            رقم الإعلان: {item.id}
          </AppText>
          {item.status === "published" && !!similar.data?.length ? (
            <AppText variant="heading" style={{ fontSize: 18 }}>
              إعلانات مشابهة
            </AppText>
          ) : null}
        </View>
        }
        ListFooterComponent={item.status === "published" && (similar.isPending || similar.isError) ? (
          <View style={s.similarNotice} accessibilityLiveRegion="polite">
            <AppText variant="caption">
              {similar.isPending ? "جارٍ تحميل الإعلانات المشابهة…" : "تعذّر تحميل الإعلانات المشابهة."}
            </AppText>
            {similar.isError ? <Button
              title="إعادة المحاولة"
              variant="ghost"
              loading={similar.isFetching}
              onPress={() => void similar.refetch()}
            /> : null}
          </View>
        ) : undefined}
      />
      <View style={[s.actions, { paddingBottom: Math.max(18, insets.bottom + 12) }]}>
        {own ? (
          <Button
            title="إدارة إعلانك"
            icon="create-outline"
            onPress={() =>
              router.push(`/create/${encodeURIComponent(item.id)}`)
            }
          />
        ) : (
          <View style={{ flexDirection: "row-reverse", gap: 10 }}>
            <Button
              title="راسل المعلن"
              icon="chatbubble-ellipses-outline"
              loading={message.isPending}
              onPress={() => requireUser(() => message.mutate())}
              style={{ flex: 1 }}
            />
            <Button
              title="اتصال"
              icon="call-outline"
              variant="secondary"
              onPress={() => void contact()}
            />
          </View>
        )}
      </View>
      <Modal
        visible={gallery}
        transparent
        animationType="fade"
        onRequestClose={() => setGallery(false)}
      >
        <GestureHandlerRootView style={{ flex: 1 }}>
          {gallery && images.length ? <ListingGallery
            images={images}
            initialIndex={index}
            onIndexChange={setIndex}
            onClose={() => setGallery(false)}
          /> : null}
        </GestureHandlerRootView>
      </Modal>
      <Modal
        visible={report}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setReport(false)}
      >
        <Screen scroll feedbackModal>
          <PageHeader
            title="الإبلاغ عن الإعلان"
            back={false}
            right={
              <Pressable onPress={() => setReport(false)}>
                <Icon name="close" />
              </Pressable>
            }
          />
          <Card>
            <AppText>
              ساعدنا في الحفاظ على جودة السوق. وضّح سبب البلاغ لتراجعه الإدارة.
            </AppText>
            <Field
              label="سبب البلاغ"
              value={reason}
              onChangeText={setReason}
              multiline
              maxLength={120}
            />
            {error ? <AppText color={colors.danger}>{error}</AppText> : null}
            <Button title="إرسال البلاغ" onPress={() => void sendReport()} />
          </Card>
        </Screen>
      </Modal>
    </Screen>
    </GalleryPreviewProvider></ListingCardRecoveryProvider>
  );
}
const useStyles = createThemedStyles((colors) => StyleSheet.create({
  photos: { gap: listingPhotoGap },
  photoFrame: {
    height: listingPhotoHeight,
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: colors.imageBackground,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  counter: {
    position: "absolute",
    right: 12,
    top: 12,
    flexDirection: "row",
    gap: 6,
    backgroundColor: colors.mediaOverlay,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 10,
  },
  content: { padding: 20, gap: 20 },
  similarRow: { paddingHorizontal: 20, paddingBottom: 12 },
  similarNotice: { paddingHorizontal: 20, paddingBottom: 12, gap: 8 },
  meta: { flexDirection: "row-reverse", flexWrap: "wrap", gap: 12 },
  metaItem: { flexDirection: "row-reverse", alignItems: "center", gap: 6 },
  attribute: {
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 12,
  },
  seller: { flexDirection: "row-reverse", alignItems: "center", gap: 13 },
  avatar: {
    height: 50,
    width: 50,
    borderRadius: 18,
    backgroundColor: colors.primarySoft,
    alignItems: "center",
    justifyContent: "center",
  },
  actions: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    padding: 18,
    paddingBottom: 28,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  gallery: { flex: 1, backgroundColor: "#08111D", direction: "ltr" },
  close: {
    position: "absolute",
    top: 58,
    right: 25,
    zIndex: 2,
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFF18",
    borderRadius: 22,
  },
  galleryFooter: {
    position: "absolute",
    bottom: 36,
    left: 20,
    right: 20,
    alignItems: "center",
    gap: 8,
  },
  galleryCounter: {
    color: "white",
    backgroundColor: "#14243A99",
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
    fontSize: 13,
  },
  galleryHint: { color: "#FFFFFFCC", fontSize: 12 },
}));
