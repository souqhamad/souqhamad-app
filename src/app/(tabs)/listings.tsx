import { useActionMutation as useMutation } from "../../ui/action-mutation";
import { SystemAlert as Alert, useFeedback } from "../../ui/feedback";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { FlatList, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTheme } from "../../ui/theme-context";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useVisibleInfiniteQuery as useInfiniteQuery } from "../../core/visible-query";
import * as Crypto from "expo-crypto";
import { api } from "../../core/api";
import { useAuth } from "../../core/auth";
import { useListingPublication } from "../../core/listing-publication-context";
import type { PublicationJob } from "../../core/listing-publication";
import { listingPublicationFieldsMessage } from "../../core/listing-publication-fields";
import { userMessage } from "../../core/errors";
import { nextListingPage, uniqueListings } from "../../core/pagination";
import type { Listing, Pagination } from "../../core/types";
import {
  ActionMenu,
  Button,
  Chip,
  EmptyState,
  InlineNotice,
  ListingCard,
  LoadingState,
  PageHeader,
  Screen,
  type ActionMenuItem,
} from "../../ui";

const statuses: Record<Listing["status"], string> = {
  draft: "مسودة",
  pending: "قيد المراجعة",
  published: "منشور",
  paused: "متوقف",
  sold: "تم بيعه",
  rejected: "غير منشور",
  deleted: "محذوف",
};
const filters = [
  ["all", "الكل"],
  ["published", "المنشورة"],
  ["draft", "المسودات"],
  ["pending", "قيد المراجعة"],
  ["paused", "المتوقفة"],
  ["sold", "المباعة"],
  ["rejected", "غير المنشورة"],
] as const;

export default function ListingsScreen() {
  const feedback = useFeedback();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { user, status } = useAuth();
  const { coordinator, jobs } = useListingPublication();
  const [filter, setFilter] = useState<string>("all");
  const [menuListingId, setMenuListingId] = useState<string | null>(null);
  const [pageFailure, setPageFailure] = useState<{ scope: string; error: unknown } | null>(null);
  const filterScroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const listingList = useRef<FlatList<Listing>>(null);
  const revealPublication = useRef(false);
  const filterSizing = useRef({ contentWidth: 0, viewportWidth: 0, interacted: false });
  const filterPageAttempt = useRef("");
  const query = useInfiniteQuery({
    queryKey: ["my-listings", user?.id],
    enabled: !!user,
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      api.get<{ listings: Listing[]; pagination: Pagination }>(
        "/api/marketplace/me/listings",
        { page: pageParam, limit: 24 },
        { signal },
      ),
    getNextPageParam: (page, _pages, pageParam) => nextListingPage(page.pagination, pageParam),
  });
  const update = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string; previousStatus: Listing["status"] }) =>
      api.patch<{ listing: Listing }>(
        `/api/marketplace/listings/${encodeURIComponent(id)}`,
        { action },
        { idempotencyKey: Crypto.randomUUID() },
      ),
    onSuccess: (result, variables) => {
      const state = result.listing?.status;
      const messages: Partial<Record<Listing["status"], string>> = { published: "تم نشر إعلانك", paused: "تم إيقاف إعلانك", deleted: "تم حذف الإعلان", sold: "تم تسجيل الإعلان كمباع", pending: "الإعلان قيد المراجعة", draft: "تم حفظ المسودة", rejected: "الإعلان غير منشور" };
      if (state === "published" && variables.action === "publish" && variables.previousStatus === "paused") feedback.success("تم استئناف نشر إعلانك");
      else if (state && messages[state]) feedback.success(messages[state]!);
      else feedback.info("تم تحديث حالة الإعلان");
      void query.refetch();
    },
    onError: error => feedback.error(error, "تعذّر تحديث الإعلان. أعد المحاولة."),
  });
  function action(item: Listing, value: string) {
    if (value === "publish" && (item.status === "draft" || item.status === "pending")) {
      const message = listingPublicationFieldsMessage(item);
      if (message) {
        Alert.alert("استكمال الإعلان", message, [
          { text: "إلغاء", style: "cancel" },
          { text: "تعديل الإعلان", onPress: () => router.push(`/create/${encodeURIComponent(item.id)}`) },
        ]);
        return;
      }
    }
    const labels: Record<string, string> = {
      mark_sold: "تأكيد البيع",
      delete: "حذف الإعلان",
      pause: "إيقاف الإعلان",
      publish: item.status === "paused" ? "استئناف النشر" : "نشر الإعلان",
    };
    Alert.alert(
      labels[value],
      value === "mark_sold"
        ? "سيتم تسجيل رسوم المنصة بنسبة 1% من قيمة البيع."
        : value === "delete"
          ? "سيُزال الإعلان من السوق وفق سياسة الحفظ."
          : value === "publish" && item.status === "paused"
            ? "تأكيد استئناف نشر الإعلان؟"
            : "تأكيد تحديث حالة الإعلان؟",
      [
        { text: "إلغاء", style: "cancel" },
        {
          text: "تأكيد",
          style: value === "delete" ? "destructive" : "default",
          onPress: () => update.mutate({ id: item.id, action: value, previousStatus: item.status }),
        },
      ],
    );
  }
  const serverListings = useMemo(() => uniqueListings(query.data?.pages || []), [query.data]);
  const publications = useMemo(() => jobs.filter(job => job.ownerId === user?.id), [jobs, user?.id]);
  const publicationById = new Map(publications.map(job => [job.listing.id, job]));
  const all = [...publications.map(job => job.listing), ...serverListings.filter(item => !publicationById.has(item.id))]
    .filter(item => item.status !== "deleted");
  const seenPublications = useRef(new Set<string>());
  useEffect(() => {
    coordinator.reconcile(serverListings);
  }, [coordinator, serverListings, jobs]);
  useEffect(() => {
    const added = publications.some(job => !seenPublications.current.has(job.id));
    seenPublications.current = new Set(publications.map(job => job.id));
    if (added) {
      revealPublication.current = true;
      listingList.current?.scrollToOffset({ offset: 0, animated: false });
    }
  }, [publications]);
  const items = all.filter(item => {
    const publication = publicationById.get(item.id);
    return (publication && publication.phase !== "complete") || filter === "all" || item.status === filter;
  });
  const pageCount = query.data?.pages.length ?? 0;
  const lookupScope = `${user?.id}:${filter}:${query.data?.pageParams.at(-1) ?? 0}:${pageCount}`;
  const failedPage = pageFailure?.scope === lookupScope ? pageFailure : null;
  const { fetchNextPage } = query;
  const loadNextPage = useCallback(async () => {
    try {
      const result = await fetchNextPage({ cancelRefetch: false });
      if (result.isFetchNextPageError) setPageFailure({ scope: lookupScope, error: result.error });
      else setPageFailure(current => current?.scope === lookupScope ? null : current);
    } catch (error) {
      setPageFailure({ scope: lookupScope, error });
    }
  }, [fetchNextPage, lookupScope]);
  useEffect(() => {
    if (!user || filter === "all" || items.length || !query.hasNextPage || query.isFetching || query.isError || failedPage) return;
    if (filterPageAttempt.current === lookupScope) return;
    filterPageAttempt.current = lookupScope;
    void loadNextPage();
  }, [user, filter, items.length, lookupScope, query.hasNextPage, query.isFetching, query.isError, failedPage, loadNextPage]);
  const menuListing = all.find(item => item.id === menuListingId);
  const menuItems: ActionMenuItem[] = menuListing ? [{
    label: "تعديل",
    icon: "create-outline",
    onPress: () => router.push(`/create/${encodeURIComponent(menuListing.id)}`),
  }] : [];
  if (menuListing) {
    if (menuListing.status === "published") {
      menuItems.push(
        { label: "إيقاف", icon: "pause-outline", disabled: update.isPending, onPress: () => action(menuListing, "pause") },
        { label: "تم البيع", icon: "checkmark-circle-outline", disabled: update.isPending, onPress: () => action(menuListing, "mark_sold") },
      );
    } else if (["draft", "paused", "pending"].includes(menuListing.status)) {
      menuItems.push({ label: menuListing.status === "paused" ? "استئناف النشر" : "نشر", icon: "cloud-upload-outline", disabled: update.isPending, onPress: () => action(menuListing, "publish") });
    }
    menuItems.push({ label: "حذف", icon: "trash-outline", destructive: true, disabled: update.isPending, onPress: () => action(menuListing, "delete") });
  }
  if (status === "loading") return <Screen><LoadingState /></Screen>;
  if (!user) return <Screen>
    <PageHeader title="إعلاناتي" />
    <EmptyState
      title="سجّل الدخول لعرض إعلاناتك"
      message="لإنشاء الإعلانات وإدارتها."
      icon="albums-outline"
      action={<Button title="تسجيل الدخول" onPress={() => router.push("/auth")} />}
    />
  </Screen>;
  const emptyTitle = filter !== "all" ? "لا توجد إعلانات بهذه الحالة" : "لا توجد إعلانات";
  const emptyAction = filter !== "all"
    ? <Button title="عرض الكل" variant="secondary" onPress={() => setFilter("all")} />
    : undefined;
  const findingFilteredListings = filter !== "all" && !items.length && query.hasNextPage && !query.isError && !failedPage;
  const retryListings = () => {
    if (query.isFetchNextPageError || failedPage) {
      setPageFailure(null);
      void loadNextPage();
    }
    else void query.refetch();
  };
  const displayError = failedPage?.error ?? query.error;
  const hasError = !!failedPage || query.isError;
  return <Screen>
    <PageHeader title="إعلاناتي" right={<Button title="إنشاء إعلان" icon="add" onPress={() => router.push("/create")} />} />
    <ScrollView ref={filterScroll} horizontal showsHorizontalScrollIndicator={false} style={s.filters} contentContainerStyle={s.filterContent}
      onContentSizeChange={width => {
        if (width <= 0 || width === filterSizing.current.contentWidth) return;
        filterSizing.current.contentWidth = width;
        if (!filterSizing.current.interacted) filterScroll.current?.scrollToEnd({ animated: false });
      }}
      onLayout={event => {
        const width = event.nativeEvent.layout.width;
        if (width <= 0 || width === filterSizing.current.viewportWidth) return;
        filterSizing.current.viewportWidth = width;
        filterScroll.current?.scrollToEnd({ animated: false });
      }}
      onScrollBeginDrag={() => { filterSizing.current.interacted = true; }}
    >
      {filters.map(([id, label]) => <Chip key={id} label={label} active={filter === id} onPress={() => {
        filterSizing.current.interacted = true;
        setFilter(id);
      }} />)}
    </ScrollView>
    <FlatList
      ref={listingList}
      data={items}
      onContentSizeChange={() => {
        if (revealPublication.current) {
          revealPublication.current = false;
          listingList.current?.scrollToOffset({ offset: 0, animated: false });
        }
      }}
      keyExtractor={item => item.id}
      contentContainerStyle={[s.list, { paddingBottom: 112 + insets.bottom }]}
      ItemSeparatorComponent={() => <View style={s.separator} />}
      ListHeaderComponent={hasError && items.length ? <View style={s.notice}><InlineNotice message={userMessage(displayError, "تعذّر تحديث إعلاناتك.")} onRetry={retryListings} busy={query.isFetching} /></View> : undefined}
      onEndReached={() => { if (query.hasNextPage && !query.isFetching && !hasError) void loadNextPage(); }}
      onEndReachedThreshold={0.5}
      refreshControl={<RefreshControl
        refreshing={query.isRefetching && !query.isFetchingNextPage}
        onRefresh={() => void query.refetch()}
        tintColor={colors.primary}
        colors={[colors.primary]}
        progressBackgroundColor={colors.surface}
      />}
      ListEmptyComponent={query.isPending || findingFilteredListings ? <LoadingState /> : hasError ? <EmptyState
        title="تعذّر تحميل إعلاناتك"
        message={userMessage(displayError, "حاول مرة أخرى.")}
        icon="cloud-offline-outline"
        action={<Button title="إعادة المحاولة" onPress={retryListings} />}
      /> : <EmptyState
        title={emptyTitle}
        icon="albums-outline"
        action={emptyAction}
      />}
      ListFooterComponent={items.length > 0 && query.isFetchingNextPage ? <LoadingState /> : items.length > 0 && query.hasNextPage && !hasError ? <Button title="تحميل المزيد" variant="ghost" onPress={() => void loadNextPage()} /> : undefined}
      renderItem={({ item }) => {
        const publication = publicationById.get(item.id);
        return <View>
          <ListingCard
            listing={item}
            imageAbsenceKnown={!publication}
            localPreviewUri={publication && !item.images?.length ? publication.photos[0]?.asset.uri : undefined}
            statusLabel={publication ? publicationLabel(publication) : statuses[item.status]}
            onPress={() => {
              if (publication?.phase === "failed") { coordinator.retry(publication.id); return; }
              if (publication && publication.phase !== "complete") return;
              router.push(item.status === "published" ? `/listings/${encodeURIComponent(item.id)}` : `/create/${encodeURIComponent(item.id)}`);
            }}
            onMenuPress={publication ? undefined : () => setMenuListingId(item.id)}
          />
          {publication?.phase === "failed" && <InlineNotice
            message={publication.error || "تعذر إكمال نشر الإعلان."}
            onRetry={() => coordinator.retry(publication.id)}
          />}
        </View>;
      }}
    />
    <ActionMenu visible={!!menuListing} title={menuListing?.title || "مسودة إعلان"} items={menuItems} onClose={() => setMenuListingId(null)} />
  </Screen>;
}

function publicationLabel(job: PublicationJob) {
  if (job.phase === "complete") return statuses[job.listing.status];
  if (job.phase === "failed") return "تعذر النشر · أعد المحاولة";
  return "جارٍ نشر الإعلان";
}

const s = StyleSheet.create({
  filters: { flexGrow: 0, minHeight: 52 },
  filterContent: { paddingHorizontal: 12, paddingBottom: 8, gap: 6, flexDirection: "row-reverse" },
  list: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 24, flexGrow: 1 },
  separator: { height: 8 },
  notice: { paddingBottom: 8 },
});
