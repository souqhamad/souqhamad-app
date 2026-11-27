import { ListingCardRecoveryProvider } from "../../ui/listing-card-recovery";
import { openAssistant } from "../assistant/entry";
import { useFeedback } from "../../ui/feedback";
import { createThemedStyles, useTheme } from "../../ui/theme-context";
import { LocationPinIcon } from "../../ui/location-pin-icon";
import { useCallback, useEffect, useMemo, useRef, useState, type ElementRef } from "react";
import {
  FlatList,
  ActivityIndicator,
  Animated,
  Keyboard,
  Modal,
  Platform,
  Pressable as NativePressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type ViewStyle,
} from "react-native";
import { Image } from "expo-image";
import { GestureDetector, Pressable } from "react-native-gesture-handler";
import Reanimated, { useAnimatedRef } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useVisibleInfiniteQuery as useInfiniteQuery } from "../../core/visible-query";
import { router } from "expo-router";
import { api } from "../../core/api";
import { nextListingPage, uniqueListings } from "../../core/pagination";
import { useAuth } from "../../core/auth";
import { useBootstrap } from "../../core/bootstrap";
import { getNearbyMarketplaceCity } from "../../core/location";
import type { Listing, Pagination } from "../../core/types";
import {
  AppText,
  Icon,
  InlineNotice,
  Screen,
  fonts,
} from "../../ui";
import { MarketFilterSheet, type MarketFilters } from "./filter-sheet";
import { useMarketToolbar } from "./use-market-toolbar";
import { useMarketRefresh } from "./use-market-refresh";
import { retainedCategoryRows } from "./toolbar-motion";
import { MarketFeed } from "./market-feed";
import { MarketToolbarTools } from "./market-toolbar-tools";
import { MarketHeaderMessage } from "./market-header-message";
import { NavigationBlurContent } from "../navigation/scene-blur";

type Choice = { id: string; label: string };
const CATEGORY_ROW_HEIGHT = 40;
type FilterRow = {
  level: "groups" | "categories" | "options" | "models";
  label: string;
  value: string;
  choices: Choice[];
  select: (value: string) => void;
};

function CategoryRow({ row, onStepBack }: { row: FilterRow; onStepBack?: () => void }) {
  const { colors } = useTheme();
  const s = useStyles();
  const scroll = useRef<ElementRef<typeof ScrollView>>(null);
  const positions = useRef(new Map<string, { x: number; width: number }>());
  const width = useRef(0);
  const offset = useRef(0);
  const contentWidth = useRef(0);
  const interacted = useRef(false);
  const revealSelection = useCallback(() => {
    if (!width.current || interacted.current) return;
    // With an explicit reversed Arabic row the first item is at the right edge.
    // Wait for content sizing; the first chip's earlier layout can still be 0.
    if (row.value === "all") {
      if (contentWidth.current > 0) scroll.current?.scrollToEnd({ animated: false });
      return;
    }
    const selected = positions.current.get(row.value);
    if (!selected || !width.current) return;
    const next = selected.x < offset.current
      ? selected.x
      : selected.x + selected.width > offset.current + width.current
        ? selected.x + selected.width - width.current
        : offset.current;
    if (next !== offset.current) scroll.current?.scrollTo({ x: Math.max(0, next), animated: true });
  }, [row.value]);
  useEffect(() => { interacted.current = false; revealSelection(); }, [revealSelection]);
  return <ScrollView
    ref={scroll}
    horizontal
    accessibilityLabel={row.label}
    showsHorizontalScrollIndicator={false}
    contentContainerStyle={s.categoryTrack}
    style={s.categoryRow}
    onLayout={event => { width.current = event.nativeEvent.layout.width; revealSelection(); }}
    onContentSizeChange={value => { contentWidth.current = value; revealSelection(); }}
    onScrollBeginDrag={() => { interacted.current = true; }}
    onScroll={event => { offset.current = event.nativeEvent.contentOffset.x; }}
    scrollEventThrottle={32}
  >
    {row.choices.map(choice => {
      const active = row.value === choice.id;
      return <Pressable
        key={choice.id}
        accessibilityRole="button"
        accessibilityLabel={choice.label}
        accessibilityState={{ selected: active }}
        onLayout={event => { positions.current.set(choice.id, event.nativeEvent.layout); if (active) revealSelection(); }}
        onPress={() => active && onStepBack ? onStepBack() : row.select(choice.id)}
        accessibilityHint={active && onStepBack ? "إظهار التصنيفات السابقة" : undefined}
        style={[s.categoryChip, row.level !== "groups" && s.compactChip, active && s.activeChip]}
      >{active && onStepBack ? <Icon name="chevron-up" size={12} color={colors.onPrimary} /> : null}<AppText numberOfLines={1} style={[s.categoryLabel, row.level !== "groups" && s.compactLabel, active && s.activeLabel]}>{choice.label}</AppText></Pressable>;
    })}
  </ScrollView>;
}

export default function MarketScreen() {
  const feedback = useFeedback();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const s = useStyles();
  const bootstrap = useBootstrap();
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<MarketFilters>({});
  const [filterOpen, setFilterOpen] = useState(false);
  const [cityOpen, setCityOpen] = useState(false);
  const [citySearch, setCitySearch] = useState("");
  const [locating, setLocating] = useState(false);
  const [rowStart, setRowStart] = useState(0);
  const [failedPageScope, setFailedPageScope] = useState<string | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [categoryY] = useState(() => new Animated.Value(0));
  const feed = useAnimatedRef<FlatList<Listing>>();
  const loadingMore = useRef<Promise<unknown> | null>(null);
  const categories = bootstrap.data?.categories ?? [];
  const cities = bootstrap.data?.cities ?? [];
  const groups = [...new Set(categories.map(category => category.group))];
  const selectedCategory = categories.find(category => category.id === filters.category);
  const selectedGroup = selectedCategory?.group || filters.group;
  const groupCategories = categories.filter(category => category.group === selectedGroup);
  const options = selectedCategory?.options ?? [];
  const models = selectedCategory?.id === "cars" && filters.categoryOption
    ? selectedCategory.carModels?.[filters.categoryOption] ?? []
    : [];
  const activeCount = Object.entries(filters).filter(([key, value]) => key !== "group" && Boolean(value)).length;

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 350);
    return () => clearTimeout(timer);
  }, [search]);
  const listings = useInfiniteQuery({
    queryKey: ["marketplace", query, filters],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => {
      // Group labels are presentation only. The server receives stable IDs.
      const apiFilters = { ...filters };
      delete apiFilters.group;
      return api.get<{ listings: Listing[]; pagination: Pagination }>(
        "/api/marketplace/listings",
        { q: query, ...apiFilters, page: pageParam, limit: 24 },
        { signal },
      );
    },
    getNextPageParam: (page, _pages, pageParam) => nextListingPage(page.pagination, pageParam),
  });
  const items = useMemo(() => uniqueListings(listings.data?.pages ?? []), [listings.data?.pages]);
  const { hasNextPage, isFetching, isFetchNextPageError, fetchNextPage, refetch: refetchListings } = listings;
  const refresh = useMarketRefresh({ refreshListings: refetchListings, refreshBootstrap: bootstrap.refetch });
  const feedScope = JSON.stringify([query, filters]);
  const loadMore = useCallback((retry = false) => {
    if (!hasNextPage || isFetching || loadingMore.current ||
        ((isFetchNextPageError || failedPageScope === feedScope) && !retry)) return;
    if (retry) setFailedPageScope(null);
    const pending = fetchNextPage({ cancelRefetch: false });
    loadingMore.current = pending;
    void pending.then(result => {
      if (result.isError) setFailedPageScope(feedScope);
    }, () => setFailedPageScope(feedScope)).finally(() => {
      if (loadingMore.current === pending) loadingMore.current = null;
    }).catch(() => {});
  }, [hasNextPage, isFetching, isFetchNextPageError, fetchNextPage, failedPageScope, feedScope]);
  const retryListings = useCallback(() => { void refetchListings(); }, [refetchListings]);
  const loadMoreListings = useCallback(() => loadMore(), [loadMore]);
  const retryMoreListings = useCallback(() => loadMore(true), [loadMore]);
  const showAllListings = useCallback(() => { setSearch(""); setFilters({}); setRowStart(0); }, []);
  const resetCategories = (group?: string) => {
    setFilters(current => ({ ...current, group,
      categories: group ? categories.filter(category => category.group === group).map(category => category.id).join(",") : undefined,
      category: undefined, categoryOption: undefined, carModel: undefined,
      yearMin: undefined, yearMax: undefined, mileageMin: undefined, mileageMax: undefined,
    }));
    setRowStart(0);
  };
  const selectRow = (index: number, action: () => void) => {
    action();
    setRowStart(Math.min(2, index));
  };
  const rows: FilterRow[] = [{
    level: "groups", label: "تصنيفات السوق", value: selectedGroup || "all",
    choices: [{ id: "all", label: "الكل" }, ...groups.map(group => ({ id: group, label: group }))],
    select: value => selectRow(0, () => resetCategories(value === "all" ? undefined : value)),
  }];
  if (selectedGroup && groupCategories.length) rows.push({
    level: "categories", label: "التصنيفات الفرعية", value: filters.category || "all",
    choices: [{ id: "all", label: "الكل" }, ...groupCategories],
    select: value => selectRow(1, () => setFilters(current => ({ ...current,
      group: selectedGroup,
      categories: value === "all" ? groupCategories.map(category => category.id).join(",") : undefined,
      category: value === "all" ? undefined : value,
      categoryOption: undefined, carModel: undefined,
      yearMin: value === "cars" ? current.yearMin : undefined,
      yearMax: value === "cars" ? current.yearMax : undefined,
      mileageMin: value === "cars" ? current.mileageMin : undefined,
      mileageMax: value === "cars" ? current.mileageMax : undefined,
    }))),
  });
  if (options.length) rows.push({
    level: "options", label: "تفريعات التصنيف", value: filters.categoryOption || "all",
    choices: [{ id: "all", label: "الكل" }, ...options],
    select: value => selectRow(2, () => setFilters(current => ({ ...current, categoryOption: value === "all" ? undefined : value, carModel: undefined }))),
  });
  if (models.length) rows.push({
    level: "models", label: "تفريعات الخيار", value: filters.carModel || "all",
    choices: [{ id: "all", label: "الكل" }, ...models],
    select: value => selectRow(3, () => setFilters(current => ({ ...current, carModel: value === "all" ? undefined : value }))),
  });
  const windowStart = Math.max(0, Math.min(rowStart, rows.length - 2));
  const startManualToolbar = useCallback(() => { setSearchFocused(false); Keyboard.dismiss(); }, []);
  const toolbar = useMarketToolbar({ feed, categoryRows: retainedCategoryRows(rows.length), locked: searchFocused || filterOpen || cityOpen, manualLocked: filterOpen || cityOpen, onManualStart: startManualToolbar });
  const { resetFeed } = toolbar;
  useEffect(() => {
    // Only new search/filter results start a new page sequence. Expanding and
    // collapsing tools neither refetches nor changes the selected categories.
    resetFeed();
  }, [feedScope, resetFeed]);
  useEffect(() => {
    Animated.timing(categoryY, {
      toValue: -windowStart * CATEGORY_ROW_HEIGHT,
      duration: 200,
      useNativeDriver: Platform.OS !== "web",
    }).start();
  }, [categoryY, windowStart]);
  const openCity = () => { setCitySearch(""); setCityOpen(true); };
  const closeCity = useCallback(() => {
    Keyboard.dismiss();
    setCityOpen(false);
  }, []);
  const findNearby = async () => {
    if (locating) return;
    setLocating(true);
    try {
      const city = await getNearbyMarketplaceCity();
      setFilters(current => ({ ...current, city }));
      feedback.success(`تم تحديد المنطقة: ${city}`);
    } catch (error) {
      feedback.error(error, "تعذّر تحديد الموقع. اختر المنطقة يدويًا.");
    } finally { setLocating(false); }
  };

  return <ListingCardRecoveryProvider revision={listings.dataUpdatedAt}><Screen>
    <View testID="market-content" style={s.marketContent}>
    <View testID="market-header" style={s.topbar}>
      <Image source={require("../../../assets/hamad-market-logo.webp")} contentFit="contain" style={s.brandLogo} testID="market-header-logo" accessibilityLabel="سوق حمد" />
      <MarketHeaderMessage message={bootstrap.data?.siteMessage} />
      <View style={s.headerActions}>
        <Pressable accessibilityRole="button" accessibilityLabel="الإشعارات" onPress={() => router.push("/notifications")} style={s.headerButton}><Icon name="notifications-outline" size={19} color={colors.text} /></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={user ? "حسابي" : "تسجيل الدخول"} onPress={() => router.push(user ? "/account" : "/auth")} style={s.headerButton}><Icon name="person-outline" size={19} color={colors.text} /></Pressable>
      </View>
    </View>
    <View testID="market-panel" style={s.marketPanel}>
      <View pointerEvents="box-none" style={s.toolbarClip}>
      <GestureDetector gesture={toolbar.gesture}>
      <Reanimated.View
        testID="market-toolbar-backdrop"
        renderToHardwareTextureAndroid={Platform.OS === "android"}
        style={[s.floatingToolbar, toolbar.toolbarStyle, Platform.OS === "web" ? { touchAction: "pan-x", userSelect: "none" } as ViewStyle : undefined]}
      >
      <Animated.View
        testID="market-toolbar"
        style={s.toolbar}
        accessibilityLabel="أدوات السوق"
      >
        <MarketToolbarTools hidden={toolbar.toolsHidden} height={toolbar.toolsHeight}>
        <View onLayout={event => toolbar.measureTools(event.nativeEvent.layout.height)} style={s.toolbarTools}>
        {bootstrap.isError && (
          <InlineNotice message="تعذّر تحديث بيانات السوق." busy={bootstrap.isFetching} onRetry={() => void bootstrap.refetch()} />
        )}
        <View style={s.creationActions}>
          <Pressable accessibilityRole="button" accessibilityLabel="أنشئ إعلانك مع حمد" onPress={() => openAssistant("listing")} style={[s.createAction, s.hamadAction]}><Icon name="megaphone-outline" size={14} color={colors.onPrimary} /><AppText numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85} maxFontSizeMultiplier={1.2} style={[s.createLabel, { color: colors.onPrimary }]}>إعلان مع حمد</AppText></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="أنشئ إعلانك يدويًا" onPress={() => router.push("/create/manual")} style={s.createAction}><Icon name="megaphone-outline" size={14} color={colors.text} /><AppText numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85} maxFontSizeMultiplier={1.2} style={s.createLabel}>إعلان يدوي</AppText></Pressable>
        </View>
        <View style={s.searchRow}>
          <View style={s.search}>
            <Icon name="search-outline" size={17} color={colors.primary} />
            <TextInput accessibilityLabel="البحث في السوق" value={search} onChangeText={setSearch} onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)} returnKeyType="search" placeholder="ابحث عن إعلان" placeholderTextColor={colors.muted} selectionColor={colors.primary} style={s.searchInput} />
            {search ? <Pressable accessibilityRole="button" accessibilityLabel="مسح البحث" hitSlop={6} onPress={() => { setSearch(""); setQuery(""); }}><Icon name="close" size={17} color={colors.muted} /></Pressable> : null}
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="تصفية النتائج" accessibilityState={{ expanded: filterOpen }} onPress={() => setFilterOpen(true)} style={[s.filterButton, activeCount > 0 && s.filterActive]}><Icon name="options-outline" size={18} color={activeCount ? colors.onPrimary : colors.primary} />{activeCount ? <View style={s.filterBadge}><AppText style={s.filterBadgeText}>{activeCount}</AppText></View> : null}</Pressable>
        </View>
        <View style={s.regionRow}>
          <Pressable accessibilityRole="button" accessibilityLabel="المنطقة" onPress={openCity} style={s.cityButton}><Icon name="location-outline" size={16} color={colors.primary} /><AppText numberOfLines={1} style={s.cityLabel}>{filters.city || "المنطقة"}</AppText><Icon name="chevron-down" size={14} color={colors.muted} /></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="موقعي" accessibilityHint="يحتاج إذن الموقع لتحديد أقرب منطقة" accessibilityState={{ disabled: locating, busy: locating }} disabled={locating} onPress={() => void findNearby()} style={[s.locationButton, locating && { opacity: 0.6 }]}>
            <View style={s.locationIcon}>{locating ? <ActivityIndicator color={colors.primary} size="small" /> : <LocationPinIcon />}</View>
          </Pressable>
        </View>
        {activeCount > 0 && <Pressable accessibilityRole="button" accessibilityLabel="مسح الفلاتر" onPress={() => { setFilters({}); setRowStart(0); }} style={s.clearFilters}><Icon name="close" size={13} color={colors.primary} /><AppText style={s.clearLabel}>مسح الفلاتر</AppText></Pressable>}
        </View>
        </MarketToolbarTools>
        <Animated.View testID="market-categories" style={[s.categoryWindow, { height: toolbar.categoryHeight }]} accessibilityLabel="اختيار التصنيف">
          <Animated.View style={{ transform: [{ translateY: categoryY }] }}>
            {rows.map((row, rowIndex) => {
              const visible = rowIndex >= windowStart && rowIndex < windowStart + 2;
              return <View key={row.level} style={{ height: CATEGORY_ROW_HEIGHT }} pointerEvents={visible ? "auto" : "none"} accessibilityElementsHidden={!visible} importantForAccessibility={visible ? "auto" : "no-hide-descendants"}>
                <CategoryRow row={row} onStepBack={rowIndex === windowStart && windowStart > 0 ? () => setRowStart(windowStart - 1) : undefined} />
              </View>;
            })}
          </Animated.View>
        </Animated.View>
      </Animated.View>
      </Reanimated.View>
      </GestureDetector>
      <View testID="market-toolbar-top-edge" pointerEvents="none" style={s.toolbarTopEdge}><View style={s.toolbarTopSurface} /></View>
      </View>
      <NavigationBlurContent><MarketFeed
        feedRef={feed}
        items={items}
        leadingSpace={toolbar.leadingSpace}
        minimumContentHeight={toolbar.minimumContentHeight}
        bottomInset={insets.bottom}
        onFeedLayout={toolbar.measureFeed}
        onFeedContentSize={toolbar.measureContent}
        onScroll={toolbar.onScroll}
        query={query}
        hasFilters={Boolean(activeCount || query)}
        refreshing={refresh.refreshing}
        onRefresh={refresh.onRefresh}
        onRetry={retryListings}
        onLoadMore={loadMoreListings}
        onRetryMore={retryMoreListings}
        onShowAll={showAllListings}
        isPending={listings.isPending}
        isError={listings.isError}
        error={listings.error}
        isRefetchError={listings.isRefetchError}
        isFetchingNextPage={listings.isFetchingNextPage}
        isFetchNextPageError={listings.isFetchNextPageError || failedPageScope === feedScope}
        hasNextPage={listings.hasNextPage}
      /></NavigationBlurContent>
    </View>
    </View>
    <MarketFilterSheet visible={filterOpen} filters={filters} categories={categories} cities={cities} onApply={next => { setFilters(next); setRowStart(next.carModel || next.categoryOption ? 2 : next.category ? 1 : 0); setFilterOpen(false); }} onClose={() => setFilterOpen(false)} />
    <Modal visible={cityOpen} transparent animationType="fade" onRequestClose={closeCity}>
      <View style={s.cityOverlay}>
        {/* React Native Modal has a separate native root on Android. Keep its
            controls on React Native responders; Gesture Handler needs another
            root inside the Modal and otherwise swallows taps on these controls. */}
        <NativePressable accessibilityRole="button" accessibilityLabel="إغلاق اختيار المنطقة" style={[StyleSheet.absoluteFill, s.cityBackdrop]} onPress={closeCity} />
        <View style={s.citySheet}>
          <View style={s.citySheetHeader}><AppText variant="heading" style={s.cityTitle}>اختيار المنطقة</AppText><NativePressable accessibilityRole="button" accessibilityLabel="إغلاق اختيار المنطقة" hitSlop={10} onPress={closeCity}><Icon name="close" size={21} /></NativePressable></View>
          <View style={s.citySearch}><Icon name="search-outline" size={17} color={colors.muted} /><TextInput accessibilityLabel="البحث عن منطقة" placeholder="ابحث عن منطقة" value={citySearch} onChangeText={setCitySearch} style={s.citySearchInput} placeholderTextColor={colors.muted} selectionColor={colors.primary} /></View>
          <FlatList data={["كل المناطق", ...cities.filter(city => city.includes(citySearch.trim()))]} keyExtractor={city => city} keyboardShouldPersistTaps="handled" renderItem={({ item: city }) => {
            const value = city === "كل المناطق" ? undefined : city;
            const active = filters.city === value;
            return <NativePressable accessibilityRole="button" accessibilityLabel={city} accessibilityState={{ selected: active }} onPress={() => { setFilters(current => ({ ...current, city: value })); closeCity(); }} style={s.cityChoice}><AppText color={active ? colors.primary : colors.text}>{city}</AppText>{active && <Icon name="checkmark" color={colors.primary} size={18} />}</NativePressable>;
          }} />
        </View>
      </View>
    </Modal>
  </Screen></ListingCardRecoveryProvider>;
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  marketContent: { flex: 1, width: "100%", maxWidth: 720, alignSelf: "center" },
  topbar: { height: 56, flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 10, backgroundColor: colors.subtle, borderBottomWidth: 1, borderColor: colors.border },
  brandLogo: { width: 48, height: 48, flexShrink: 0, borderRadius: 6, backgroundColor: colors.surface },
  headerActions: { flexDirection: "row-reverse", alignItems: "center", flexShrink: 0, gap: 5 },
  headerButton: { width: 34, height: 34, borderRadius: 6, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  marketPanel: { flex: 1, marginHorizontal: 6, borderWidth: 1, borderColor: colors.border, borderRadius: 6, backgroundColor: colors.background, overflow: "hidden" },
  toolbar: { borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.surface, padding: 4, overflow: "hidden" },
  toolbarTools: { gap: 4, paddingBottom: 4 },
  // The fixed clipping surface never changes the feed's layout. Its empty
  // lower area passes touches through to the visible listing cards.
  toolbarClip: { ...StyleSheet.absoluteFill, zIndex: 2, elevation: 2, overflow: "hidden" },
  toolbarTopEdge: { position: "absolute", top: 0, left: 0, right: 0, height: 5, paddingHorizontal: 8, backgroundColor: colors.background, zIndex: 3, elevation: 3 },
  toolbarTopSurface: { flex: 1, backgroundColor: colors.surface, borderTopLeftRadius: 12, borderTopRightRadius: 12, borderTopWidth: 1, borderColor: colors.border },
  // Cover the upper and side gutters as well as the rounded toolbar corners.
  floatingToolbar: { position: "absolute", top: 0, left: 0, right: 0, paddingHorizontal: 8, backgroundColor: colors.background, zIndex: 2, elevation: 2 },
  creationActions: { flexDirection: "row-reverse", gap: 6 },
  createAction: { flex: 1, minWidth: 0, minHeight: 32, borderRadius: 6, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", paddingHorizontal: 5, paddingVertical: 3, gap: 4 },
  hamadAction: { backgroundColor: colors.primaryFill, borderColor: colors.primaryFill },
  createLabel: { fontSize: 11.5, lineHeight: 18, fontFamily: fonts.medium, color: colors.text, flexShrink: 1, textAlign: "center" },
  searchRow: { flexDirection: "row-reverse", gap: 4 },
  search: { flex: 1, minWidth: 0, height: 36, borderWidth: 1, borderColor: colors.border, borderRadius: 6, backgroundColor: colors.subtle, paddingHorizontal: 8, flexDirection: "row-reverse", gap: 5, alignItems: "center" },
  searchInput: { flex: 1, minWidth: 0, height: 36, fontFamily: fonts.regular, fontSize: 14, color: colors.text, textAlign: "right", writingDirection: "rtl", paddingVertical: 0 },
  filterButton: { width: 36, height: 36, borderRadius: 6, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  filterActive: { backgroundColor: colors.primaryFill, borderColor: colors.primaryFill },
  filterBadge: { position: "absolute", top: -3, left: -3, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" },
  filterBadgeText: { color: colors.primary, fontSize: 10, lineHeight: 14, fontFamily: fonts.bold },
  regionRow: { flexDirection: "row-reverse", alignItems: "center", gap: 4 },
  locationButton: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" },
  locationIcon: { width: 28, height: 30, alignItems: "center", justifyContent: "center" },
  cityButton: { flex: 1, height: 36, borderRadius: 6, borderWidth: 1, borderColor: colors.border, flexDirection: "row-reverse", gap: 5, alignItems: "center", paddingHorizontal: 8 },
  cityLabel: { flex: 1, fontSize: 12, lineHeight: 20 },
  clearFilters: { flexDirection: "row-reverse", alignItems: "center", alignSelf: "flex-end", gap: 3, paddingVertical: 3, paddingHorizontal: 5 },
  clearLabel: { color: colors.primary, fontSize: 11, lineHeight: 18 },
  categoryWindow: { overflow: "hidden" },
  categoryRow: { height: CATEGORY_ROW_HEIGHT, flexGrow: 0 },
  categoryTrack: { flexDirection: "row-reverse", gap: 6, paddingHorizontal: 1, alignItems: "center", height: CATEGORY_ROW_HEIGHT },
  categoryChip: { height: 34, borderRadius: 18, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.border, flexDirection: "row-reverse", gap: 3, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  compactChip: { height: 28, paddingHorizontal: 10 },
  categoryLabel: { fontSize: 12, lineHeight: 18, color: colors.text },
  compactLabel: { fontSize: 11, lineHeight: 17 },
  activeChip: { backgroundColor: colors.primaryFill, borderColor: colors.primaryFill },
  activeLabel: { color: colors.onPrimary, fontFamily: fonts.bold },
  cityOverlay: { flex: 1, backgroundColor: colors.overlay, justifyContent: "center", padding: 28, direction: "ltr" },
  // Keep the dismiss layer underneath the interactive sheet on Android. Without
  // an explicit native stacking order it can win hit testing and trap every tap.
  cityBackdrop: { zIndex: 0, elevation: 0 },
  citySheet: { position: "relative", zIndex: 1, elevation: 1, maxHeight: "75%", minHeight: 250, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, padding: 14, gap: 12 },
  citySheetHeader: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", gap: 12 },
  cityTitle: { fontSize: 16 },
  citySearch: { height: 40, flexDirection: "row-reverse", alignItems: "center", gap: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 10 },
  citySearchInput: { flex: 1, height: 38, textAlign: "right", writingDirection: "rtl", fontFamily: fonts.regular, fontSize: 13, color: colors.text },
  cityChoice: { minHeight: 42, paddingVertical: 9, flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
}));
