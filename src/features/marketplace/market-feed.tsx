import { memo, useCallback } from "react";
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View } from "react-native";
import Reanimated, { type AnimatedRef } from "react-native-reanimated";
import { userMessage } from "../../core/errors";
import type { Listing } from "../../core/types";
import { AppText, Button, EmptyState, Icon, InlineNotice, ListingCard, LoadingState, fonts } from "../../ui";
import { useTheme } from "../../ui/theme-context";
import type { useMarketToolbar } from "./use-market-toolbar";

type Toolbar = ReturnType<typeof useMarketToolbar<Listing>>;
export type MarketFeedProps = {
  items: Listing[];
  feedRef: AnimatedRef<FlatList<Listing>>;
  onScroll: Toolbar["onScroll"];
  onFeedLayout: (height: number) => void;
  onFeedContentSize: (height: number) => void;
  leadingSpace: number;
  minimumContentHeight: number;
  bottomInset: number;
  query: string;
  hasFilters: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onRetry: () => void;
  onLoadMore: () => void;
  onRetryMore: () => void;
  onShowAll: () => void;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  isRefetchError: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  hasNextPage: boolean;
};

const keyExtractor = (item: Listing) => item.id;
const MarketListingCard = memo(ListingCard);
// Reuse a row's drawing while the floating tools and glass are composited.
// FlatList still owns mounting and releases rows outside its render window.
const renderListing = ({ item }: { item: Listing }) => <MarketListingCard listing={item} cacheDrawing />;
function CardSeparator() { return <View style={styles.cardSeparator} />; }

/** Scroll position and layout stay native; toolbar visibility is not a prop. */
export const MarketFeed = memo(function MarketFeed({
  items, feedRef, onScroll, onFeedLayout, onFeedContentSize,
  leadingSpace, minimumContentHeight, bottomInset, query, hasFilters,
  refreshing, onRefresh, onRetry, onLoadMore, onRetryMore, onShowAll,
  isPending, isError, error, isRefetchError, isFetchingNextPage, isFetchNextPageError, hasNextPage,
}: MarketFeedProps) {
  const { colors } = useTheme();
  const measureLayout = useCallback((event: { nativeEvent: { layout: { height: number } } }) => {
    onFeedLayout(event.nativeEvent.layout.height);
  }, [onFeedLayout]);
  const measureContent = useCallback((_width: number, height: number) => { onFeedContentSize(height); }, [onFeedContentSize]);
  return <Reanimated.FlatList
    testID="market-feed"
    ref={feedRef}
    data={items}
    keyExtractor={keyExtractor}
    contentContainerStyle={[styles.list, { paddingBottom: 128 + bottomInset, minHeight: minimumContentHeight }]}
    onLayout={measureLayout}
    onContentSizeChange={measureContent}
    renderItem={renderListing}
    removeClippedSubviews={false}
    ItemSeparatorComponent={CardSeparator}
    ListHeaderComponent={<>
      <View pointerEvents="none" style={{ height: leadingSpace }} />
      {isRefetchError && items.length > 0 ? <InlineNotice message="تعذّر تحديث الإعلانات." onRetry={onRetry} /> : null}
      {query ? <View style={styles.resultsTitle}><Icon name="search-outline" color={colors.primary} size={16} /><AppText style={styles.resultsLabel}>نتائج البحث</AppText></View> : null}
    </>}
    refreshControl={<RefreshControl
      refreshing={refreshing}
      onRefresh={onRefresh}
      tintColor={colors.primary}
      colors={[colors.primary]}
      progressBackgroundColor={colors.surface}
      progressViewOffset={leadingSpace}
    />}
    onScroll={onScroll}
    scrollEventThrottle={16}
    onEndReached={onLoadMore}
    onEndReachedThreshold={0.5}
    keyboardDismissMode="on-drag"
    ListFooterComponent={isFetchingNextPage
      ? <View style={styles.pageLoading}><ActivityIndicator color={colors.primary} accessibilityLabel="تحميل إعلانات إضافية" /></View>
      : isFetchNextPageError
        ? <InlineNotice message="تعذّر تحميل المزيد." onRetry={onRetryMore} />
        : hasNextPage ? <Button title="تحميل المزيد" variant="ghost" onPress={onLoadMore} /> : <View style={styles.listEnd} />}
    ListEmptyComponent={isPending
      ? <LoadingState />
      : isError
        ? <EmptyState icon="cloud-offline-outline" title={userMessage(error, "تعذّر تحميل الإعلانات.")} action={<Button title="إعادة المحاولة" onPress={onRetry} />} />
        : <EmptyState icon="search-outline" title="لا توجد إعلانات" action={hasFilters ? <Button title="عرض الكل" variant="secondary" onPress={onShowAll} /> : undefined} />}
  />;
});

const styles = StyleSheet.create({
  list: { paddingHorizontal: 8, paddingBottom: 128, flexGrow: 1 },
  cardSeparator: { height: 6 },
  listEnd: { height: 12 },
  pageLoading: { paddingVertical: 12, alignItems: "center" },
  resultsTitle: { flexDirection: "row-reverse", alignItems: "center", gap: 6, paddingBottom: 10 },
  resultsLabel: { fontFamily: fonts.bold, fontSize: 16 },
});
