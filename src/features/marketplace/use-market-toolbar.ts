import { useCallback, useEffect, useRef, useState } from "react";
import type { FlatList } from "react-native";
import { usePanGesture } from "react-native-gesture-handler";
import {
  cancelAnimation, Easing, runOnJS, runOnUI, scrollTo, useAnimatedReaction, useDerivedValue,
  type AnimatedRef, type FrameCallback, useAnimatedScrollHandler, useAnimatedStyle, useFrameCallback, useReducedMotion, useSharedValue, withTiming,
} from "react-native-reanimated";
import { advanceToolbarFollow, boundedFeedOffset, clampToolbar, consumeToolbarIntent, manualFeedOffset, settleToolbar, toolbarMotionDuration, TOOLBAR_CHROME } from "./toolbar-motion";

export function useMarketToolbar<T>({ feed, categoryRows, locked, manualLocked, onManualStart }: {
  feed: AnimatedRef<FlatList<T>>;
  categoryRows: number;
  locked: boolean;
  manualLocked: boolean;
  onManualStart: () => void;
}) {
  const [toolsHeight, setToolsHeight] = useState(136);
  const [feedHeight, setFeedHeight] = useState(0);
  const collapse = useSharedValue(0);
  const maximum = useSharedValue(136);
  const offset = useSharedValue(0);
  const previousOffset = useSharedValue(0);
  const contentHeight = useSharedValue(0);
  const viewportHeight = useSharedValue(0);
  const scrollContentHeight = useSharedValue(0);
  const scrollViewportHeight = useSharedValue(0);
  const pendingDelta = useSharedValue(0);
  const followDirection = useSharedValue(0);
  const followTarget = useSharedValue(0);
  const manual = useSharedValue(false);
  const dragging = useSharedValue(false);
  const settleClosed = useSharedValue(false);
  const resetAtStart = useSharedValue(false);
  const manualAtTop = useSharedValue(false);
  const startCollapse = useSharedValue(0);
  const startOffset = useSharedValue(0);
  const startTranslation = useSharedValue(0);
  const dragOrigin = useSharedValue(0);
  const expectedOffset = useSharedValue(-1);
  const automaticLocked = useSharedValue(locked);
  const following = useSharedValue(false);
  const reducedMotion = useReducedMotion();
  const frameController = useRef<FrameCallback | null>(null);
  const setFollowActive = useCallback((active: boolean) => { frameController.current?.setActive(active); }, []);
  const stopFollowing = useCallback(() => {
    "worklet";
    if (!following.get()) return;
    following.set(false);
    runOnJS(setFollowActive)(false);
  }, [following, setFollowActive]);
  const renderedCollapse = useCallback(() => {
    "worklet";
    // A fast return to the first card may overtake the eased tools. Constrain
    // only their visual position, without resetting the animation each event.
    return manual.get() || resetAtStart.get()
      ? collapse.get()
      : Math.min(collapse.get(), offset.get());
  }, [collapse, manual, offset, resetAtStart]);

  // Feed events update a goal. One continuous frame callback follows it, so
  // events arriving every frame cannot repeatedly restart the easing clock.
  const followFrame = useFrameCallback(useCallback(frame => {
    "worklet";
    if (manual.get() || resetAtStart.get() || automaticLocked.get()) { stopFollowing(); return; }
    const current = renderedCollapse();
    const target = clampToolbar(followTarget.get(), Math.min(maximum.get(), offset.get()));
    const next = advanceToolbarFollow(current, target, frame.timeSincePreviousFrame ?? 16);
    if (next !== collapse.get()) collapse.set(next);
    if (next === target) stopFollowing();
  }, [automaticLocked, collapse, followTarget, manual, maximum, offset, renderedCollapse, resetAtStart, stopFollowing]), false);
  useEffect(() => {
    frameController.current = followFrame;
    return () => { frameController.current = null; };
  }, [followFrame]);

  const animateFollow = useCallback((value: number, force = false) => {
    "worklet";
    // At the start of the feed the first card must not detach from the tools.
    const target = clampToolbar(value, Math.min(maximum.get(), offset.get()));
    if (!force && Math.abs(target - followTarget.get()) < 0.25) return;
    followTarget.set(target);
    const current = renderedCollapse();
    // Preserve the visible origin when returning to the first card.
    if (current !== collapse.get()) collapse.set(current);
    if (reducedMotion || Math.abs(target - current) < 0.25) {
      collapse.set(target); stopFollowing(); return;
    }
    if (!following.get()) { following.set(true); runOnJS(setFollowActive)(true); }
  }, [collapse, following, followTarget, maximum, offset, reducedMotion, renderedCollapse, setFollowActive, stopFollowing]);

  // The feed header has a fixed expanded height. Only a manual drag near the
  // first card scrolls the list; deep cards keep their native scroll position.
  const syncManualOffset = useCallback((value: number) => {
    "worklet";
    if (!manual.get() || !manualAtTop.get()) return;
    const next = boundedFeedOffset(
      manualFeedOffset(startOffset.get(), startCollapse.get(), value, true),
      contentHeight.get(), viewportHeight.get(),
    );
    if (Math.abs(next - offset.get()) < 0.25) return;
    expectedOffset.set(next);
    offset.set(next);
    previousOffset.set(next);
    scrollTo(feed, 0, next, false);
  }, [contentHeight, expectedOffset, feed, manual, manualAtTop, offset, previousOffset, startCollapse, startOffset, viewportHeight]);
  const syncResetOffset = useCallback(() => {
    "worklet";
    const next = boundedFeedOffset(collapse.get(), contentHeight.get(), viewportHeight.get());
    if (Math.abs(next - offset.get()) < 0.25) return;
    expectedOffset.set(next);
    offset.set(next);
    previousOffset.set(next);
    scrollTo(feed, 0, next, false);
  }, [collapse, contentHeight, expectedOffset, feed, offset, previousOffset, viewportHeight]);
  const settleMotion = useCallback((closed: boolean) => {
    "worklet";
    settleClosed.set(closed);
    manual.set(true);
    const next = closed ? maximum.get() : 0;
    followTarget.set(next);
    followDirection.set(0);
    collapse.set(withTiming(next, { duration: toolbarMotionDuration(collapse.get(), next), easing: Easing.out(Easing.quad) }, finished => {
      if (!finished) return;
      syncManualOffset(next);
      previousOffset.set(offset.get());
      pendingDelta.set(0);
      manual.set(false);
    }));
  }, [collapse, followDirection, followTarget, manual, maximum, offset, pendingDelta, previousOffset, settleClosed, syncManualOffset]);

  useEffect(() => {
    runOnUI((height: number) => {
      const previous = collapse.get();
      const wasCollapsed = previous >= maximum.get() - 1;
      const targetWasCollapsed = followTarget.get() >= maximum.get() - 1;
      const previousTarget = followTarget.get();
      const resume = manual.get() && !dragging.get();
      cancelAnimation(collapse);
      maximum.set(height);
      const next = wasCollapsed ? height : clampToolbar(previous, height);
      // Rebase the finger's origin if a banner changes the measured height
      // during a drag. The feed anchor keeps its original motion baseline.
      if (dragging.get()) dragOrigin.set(dragOrigin.get() + next - previous);
      collapse.set(next);
      if (resume) settleMotion(settleClosed.get());
      else if (!manual.get() && !resetAtStart.get()) animateFollow(targetWasCollapsed ? height : previousTarget, true);
      else followTarget.set(next);
    })(toolsHeight);
  }, [animateFollow, collapse, dragOrigin, dragging, followTarget, manual, maximum, resetAtStart, settleClosed, settleMotion, toolsHeight]);
  useAnimatedReaction(() => collapse.get(), value => { syncManualOffset(value); });
  // New filters keep the chosen tools position. Remeasurement (for example the
  // clear-filters row) must also keep the first result just below the categories.
  useAnimatedReaction(
    () => [resetAtStart.get(), collapse.get(), maximum.get(), contentHeight.get(), viewportHeight.get()],
    () => { if (resetAtStart.get()) syncResetOffset(); },
  );
  // Keep a scalar between feed offsets and native transforms. Once the toolbar
  // is settled, scrolling must not enqueue an identical transform every frame.
  const visibleCollapse = useDerivedValue(() => manual.get() || resetAtStart.get()
    ? collapse.get() : Math.min(collapse.get(), offset.get()));
  // Visibility stays on the UI thread. Its accessibility/touch state belongs
  // to the tools component, so finishing a slide never re-renders the feed.
  const toolsHidden = useDerivedValue(() => {
    return visibleCollapse.get() >= maximum.get() - 1;
  });

  useEffect(() => {
    runOnUI((isLocked: boolean) => {
      automaticLocked.set(isLocked);
      if (!isLocked) return;
      const visible = renderedCollapse();
      cancelAnimation(collapse);
      collapse.set(visible);
      dragging.set(false);
      startCollapse.set(collapse.get());
      startOffset.set(offset.get());
      manualAtTop.set(offset.get() <= collapse.get() + 1);
      pendingDelta.set(0);
      settleMotion(false);
    })(locked);
  }, [automaticLocked, collapse, dragging, locked, manualAtTop, offset, pendingDelta, renderedCollapse, settleMotion, startCollapse, startOffset]);

  const resetFeed = useCallback(() => {
    runOnUI(() => {
      const visible = renderedCollapse();
      cancelAnimation(collapse);
      collapse.set(visible);
      manual.set(false);
      dragging.set(false);
      // Focused search and sheets need the tools open. A category selection
      // retains the current tools position while starting its first results.
      if (automaticLocked.get()) collapse.set(0);
      followTarget.set(collapse.get());
      followDirection.set(0);
      resetAtStart.set(true);
      pendingDelta.set(0);
      syncResetOffset();
    })();
  }, [automaticLocked, collapse, dragging, followDirection, followTarget, manual, pendingDelta, renderedCollapse, resetAtStart, syncResetOffset]);

  const onScroll = useAnimatedScrollHandler({
    onBeginDrag: event => {
      const visible = renderedCollapse();
      cancelAnimation(collapse);
      collapse.set(visible);
      manual.set(false);
      dragging.set(false);
      resetAtStart.set(false);
      expectedOffset.set(-1);
      pendingDelta.set(0);
      followDirection.set(0);
      followTarget.set(collapse.get());
      scrollContentHeight.set(event.contentSize.height);
      scrollViewportHeight.set(event.layoutMeasurement.height);
      previousOffset.set(boundedFeedOffset(event.contentOffset.y, event.contentSize.height, event.layoutMeasurement.height));
    },
    onScroll: event => {
      const visibleBeforeScroll = renderedCollapse();
      const layoutChanged = scrollContentHeight.get() > 0 && scrollViewportHeight.get() > 0 && (
        Math.abs(scrollContentHeight.get() - event.contentSize.height) > 1 ||
        Math.abs(scrollViewportHeight.get() - event.layoutMeasurement.height) > 1
      );
      scrollContentHeight.set(event.contentSize.height);
      scrollViewportHeight.set(event.layoutMeasurement.height);
      contentHeight.set(event.contentSize.height);
      viewportHeight.set(event.layoutMeasurement.height);
      const next = boundedFeedOffset(event.contentOffset.y, event.contentSize.height, event.layoutMeasurement.height);
      const delta = next - previousOffset.get();
      previousOffset.set(next);
      offset.set(next);
      if (manual.get()) return;
      // Replacing results or resizing the viewport can clamp the native offset.
      // That synthetic reverse scroll is not a request to reopen the tools.
      if (layoutChanged) { pendingDelta.set(0); return; }
      const expected = expectedOffset.get();
      if (expected >= 0) {
        expectedOffset.set(-1);
        if (Math.abs(next - expected) < 2) { pendingDelta.set(0); return; }
        if (resetAtStart.get()) return;
      }
      if (resetAtStart.get()) {
        const start = boundedFeedOffset(collapse.get(), contentHeight.get(), viewportHeight.get());
        if (Math.abs(next - start) < 2) return;
        resetAtStart.set(false);
      }
      if (automaticLocked.get()) return;
      if (next <= 0) { animateFollow(0); followDirection.set(0); pendingDelta.set(0); return; }
      const targetBeforeScroll = followTarget.get();
      if (delta === 0) return;
      const intent = consumeToolbarIntent(followDirection.get(), pendingDelta.get(), delta);
      pendingDelta.set(intent.pending);
      followDirection.set(intent.direction);
      if (intent.delta === 0) return;
      // Small alternating deltas do not turn the toolbar around. A confirmed
      // reversal starts at its visible position, not an old animation target.
      animateFollow((intent.reversed ? visibleBeforeScroll : targetBeforeScroll) + intent.delta);
    },
  });

  const gesture = usePanGesture({
    enabled: !manualLocked,
    activeOffsetY: [-9, 9],
    failOffsetX: [-12, 12],
    onActivate: event => {
      const visible = renderedCollapse();
      cancelAnimation(collapse);
      collapse.set(visible);
      startCollapse.set(visible);
      dragOrigin.set(visible);
      startOffset.set(offset.get());
      startTranslation.set(event.translationY);
      manualAtTop.set(offset.get() <= collapse.get() + 1);
      manual.set(true);
      dragging.set(true);
      resetAtStart.set(false);
      pendingDelta.set(0);
      followDirection.set(0);
      followTarget.set(collapse.get());
      runOnJS(onManualStart)();
    },
    onUpdate: event => {
      collapse.set(clampToolbar(dragOrigin.get() - (event.translationY - startTranslation.get()), maximum.get()));
    },
    onDeactivate: event => {
      const next = settleToolbar(collapse.get(), maximum.get(), event.canceled ? 0 : event.velocityY);
      dragging.set(false);
      settleMotion(next > 0);
    },
  });
  // Transform the complete, statically measured overlay. Animating a clipped
  // height here forced native layout/commit work while the feed was scrolling.
  const toolbarStyle = useAnimatedStyle(() => {
    return { transform: [{ translateY: -visibleCollapse.get() }] };
  });
  const leadingSpace = toolsHeight + categoryRows * 40 + TOOLBAR_CHROME;
  const measureFeed = useCallback((height: number) => {
    viewportHeight.set(height);
    setFeedHeight(previous => Math.abs(previous - height) < 1 ? previous : Math.ceil(height));
  }, [viewportHeight]);
  const measureContent = useCallback((height: number) => { contentHeight.set(height); }, [contentHeight]);
  const measureTools = useCallback((height: number) => {
    if (height > 0) setToolsHeight(previous => Math.abs(previous - height) < 1 ? previous : Math.ceil(height));
  }, []);
  return {
    gesture, onScroll, resetFeed, toolsHidden, toolbarStyle, toolsHeight,
    categoryHeight: categoryRows * 40, leadingSpace, expandedHeight: leadingSpace,
    minimumContentHeight: feedHeight + toolsHeight,
    measureFeed, measureContent, measureTools,
  };
}
