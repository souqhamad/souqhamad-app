import { ListingCardRecoveryProvider } from "../../ui/listing-card-recovery";
import { useActionMutation as useMutation } from "../../ui/action-mutation";
import { useFeedback } from "../../ui/feedback";
import { createThemedStyles, useTheme } from "../../ui/theme-context";
import React, { useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useVisibleQuery as useQuery } from "../../core/visible-query";
import { api } from "../../core/api";
import { useAuth } from "../../core/auth";
import type { Listing } from "../../core/types";
import {
  AppText,
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  ListingCard,
  LoadingState,
  PageHeader,
  Screen,
} from "../../ui";
import {
  Avatar,
  ErrorState,
  formatDate,
  useAccountPalette,

  useAccountStyles,
} from "../account/shared";

type Seller = {
  id: string;
  name: string;
  picture?: string;
  joinedAt?: string;
  publishedListingCount: number;
  ratingAverage: number;
  ratingCount: number;
  followerCount: number;
  listings: Listing[];
};
type RatingState = {
  status?: string;
  ratingAverage: number;
  ratingCount: number;
  myRating?: { rating: number };
  canRate?: boolean;
};
type FollowState = {
  isFollowing: boolean;
  followerCount: number;
  canFollow?: boolean;
};

export function SellerScreen({ sellerId }: { sellerId: string }) {
  const feedback = useFeedback();
  const { colors } = useTheme();
  const palette = useAccountPalette();
  const styles = useAccountStyles();
  const local = useLocalStyles();
  const { user, status } = useAuth();
  const encoded = encodeURIComponent(sellerId);
  const [reportOpen, setReportOpen] = useState(false);
  const [reason, setReason] = useState("");
  const query = useQuery({
    queryKey: ["seller", sellerId],
    queryFn: ({ signal }) =>
      api.get<{ seller: Seller }>(`/api/marketplace/users/${encoded}/profile`, undefined, { signal }),
    enabled: Boolean(sellerId),
  });
  const follow = useQuery({
    queryKey: ["account", user?.id, "seller-follow", sellerId],
    queryFn: ({ signal }) =>
      api.get<FollowState>(`/api/marketplace/users/${encoded}/follow`, undefined, { signal }),
    enabled: status === "authenticated" && Boolean(sellerId),
  });
  const rating = useQuery({
    queryKey: ["account", user?.id, "seller-rating", sellerId],
    queryFn: ({ signal }) =>
      api.get<RatingState>(`/api/marketplace/users/${encoded}/ratings`, undefined, { signal }),
    enabled: status === "authenticated" && Boolean(sellerId),
  });
  const requireAccount = (action: () => void) => {
    if (status !== "authenticated") router.push("/auth");
    else action();
  };
  const toggle = useMutation({
    mutationFn: () => api.post<FollowState>(`/api/marketplace/users/${encoded}/follow`),
    onSuccess: result => {
      if (typeof result.isFollowing === "boolean") feedback.success(result.isFollowing ? "تمت متابعة المعلن" : "تم إلغاء متابعة المعلن");
      void follow.refetch();
      void query.refetch();
    },
    onError: error => feedback.error(error),
  });
  const rate = useMutation({
    mutationFn: (value: number) =>
      api.post(`/api/marketplace/users/${encoded}/ratings`, { rating: value }),
    onSuccess: () => {
      feedback.success("تم حفظ تقييمك");
      void rating.refetch();
      void query.refetch();
    },
    onError: error => feedback.error(error),
  });
  const report = useMutation({
    mutationFn: () =>
      api.post(`/api/marketplace/users/${encoded}/reports`, {
        reason: "profile_report",
        details: reason.trim(),
      }),
    onSuccess: () => {
      setReportOpen(false);
      setReason("");
      feedback.success("تم إرسال البلاغ للإدارة");
    },
    onError: error => feedback.error(error),
  });
  const seller = query.data?.seller;
  const own = user?.id === sellerId;
  return (
    <ListingCardRecoveryProvider revision={query.dataUpdatedAt}><Screen scroll={false}>
      <PageHeader title="صفحة المعلن" back />
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : !seller ? (
        <EmptyState title="المعلن غير متاح" icon="person-outline" />
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching}
              onRefresh={() => {
                void query.refetch();
                if (status === "authenticated") {
                  void follow.refetch();
                  void rating.refetch();
                }
              }}
              tintColor={palette.primary}
              colors={[palette.primary]}
              progressBackgroundColor={palette.surface}
            />
          }
        >
          <Card style={local.identity}>
            <Avatar name={seller.name} picture={seller.picture} size={86} />
            <AppText variant="heading">{seller.name}</AppText>
            {seller.joinedAt && (
              <AppText variant="caption" color={palette.muted}>
                عضو منذ {formatDate(seller.joinedAt)}
              </AppText>
            )}
            <View style={local.stats}>
              <View style={local.stat}>
                <AppText variant="heading">
                  {seller.publishedListingCount}
                </AppText>
                <AppText variant="caption" color={palette.muted}>
                  إعلان
                </AppText>
              </View>
              <View style={local.stat}>
                <AppText variant="heading">
                  {follow.data?.followerCount ?? seller.followerCount}
                </AppText>
                <AppText variant="caption" color={palette.muted}>
                  متابع
                </AppText>
              </View>
              <View style={local.stat}>
                <AppText variant="heading">
                  {Number(
                    rating.data?.ratingAverage ?? seller.ratingAverage,
                  ).toFixed(1)}
                </AppText>
                <AppText variant="caption" color={palette.muted}>
                  {rating.data?.ratingCount ?? seller.ratingCount} تقييم
                </AppText>
              </View>
            </View>
            {!own && (
              <Button
                title={
                  follow.data?.isFollowing ? "إلغاء المتابعة" : "متابعة المعلن"
                }
                variant={follow.data?.isFollowing ? "secondary" : "primary"}
                icon="person-add-outline"
                disabled={follow.data?.canFollow === false}
                loading={toggle.isPending}
                onPress={() => requireAccount(() => toggle.mutate())}
              />
            )}
          </Card>
          {!own && (
            <Card style={styles.stack}>
              <View style={styles.between}>
                <AppText variant="label">كيف كانت تجربتك مع المعلن؟</AppText>
                <AppText variant="caption" color={palette.muted}>
                  {rate.isPending
                    ? "جار الحفظ…"
                    : rating.data?.myRating
                      ? "تقييمك"
                      : ""}
                </AppText>
              </View>
              <View style={local.stars}>
                {[1, 2, 3, 4, 5].map((value) => (
                  <Pressable
                    key={value}
                    accessibilityRole="button"
                    accessibilityLabel={`تقييم ${value} من خمسة`}
                    disabled={
                      rate.isPending ||
                      rating.data?.status === "self_rating_blocked"
                    }
                    onPress={() => requireAccount(() => rate.mutate(value))}
                    hitSlop={6}
                  >
                    <Icon
                      name={
                        (rating.data?.myRating?.rating ?? 0) >= value
                          ? "star"
                          : "star-outline"
                      }
                      size={32}
                      color={colors.warning}
                    />
                  </Pressable>
                ))}
              </View>
            </Card>
          )}
          <View style={styles.between}>
            <AppText variant="heading">إعلانات المعلن</AppText>
            <AppText variant="caption" color={palette.muted}>
              {seller.publishedListingCount} إعلان منشور
            </AppText>
          </View>
          {seller.listings.length ? (
            seller.listings.map((listing) => (
              <ListingCard
                key={listing.id}
                listing={listing}
                onPress={() =>
                  router.push(`/listings/${encodeURIComponent(listing.id)}`)
                }
              />
            ))
          ) : (
            <EmptyState
              title="لا توجد إعلانات منشورة"
              message="ستظهر إعلانات المعلن هنا عند نشرها."
              icon="albums-outline"
            />
          )}
          {!own && (
            <Button
              title="الإبلاغ عن المعلن"
              variant="ghost"
              icon="flag-outline"
              onPress={() =>
                requireAccount(() => setReportOpen((value) => !value))
              }
            />
          )}
          {reportOpen && (
            <Card style={styles.stack}>
              <AppText variant="heading">إرسال بلاغ</AppText>
              <Field
                label="تفاصيل البلاغ"
                placeholder="اشرح المشكلة لتساعد الإدارة على المراجعة"
                value={reason}
                onChangeText={setReason}
                maxLength={1000}
                multiline
              />
              <View style={styles.row}>
                <Button
                  title="إرسال البلاغ"
                  variant="danger"
                  disabled={reason.trim().length < 2}
                  loading={report.isPending}
                  onPress={() => report.mutate()}
                />
                <Button
                  title="إلغاء"
                  variant="ghost"
                  onPress={() => setReportOpen(false)}
                />
              </View>
            </Card>
          )}
        </ScrollView>
      )}
    </Screen></ListingCardRecoveryProvider>
  );
}

const useLocalStyles = createThemedStyles((colors) => StyleSheet.create({
  identity: { alignItems: "center", gap: 10, paddingVertical: 24 },
  stats: {
    flexDirection: "row-reverse",
    width: "100%",
    justifyContent: "space-around",
    paddingVertical: 16,
    marginVertical: 4,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  stat: { alignItems: "center", gap: 4 },
  stars: {
    flexDirection: "row-reverse",
    gap: 18,
    justifyContent: "center",
    paddingVertical: 5,
  },
}));
