type ScrollMetrics = {
  contentOffset: { y: number };
  contentSize: { height: number };
  layoutMeasurement: { height: number };
};

/** Keep layout/virtualization scroll events separate from a reader's intent. */
export function createConversationBottomAnchor(scope: string, now: () => number = Date.now) {
  let following = true;
  let viewportHeight = 0;
  let contentHeight = 0;
  let dragging = false;
  let momentum = false;
  let intentUntil = -Infinity;

  const observe = (metrics: ScrollMetrics) => {
    const height = metrics.layoutMeasurement.height;
    if (!Number.isFinite(height) || height <= 0) return;
    // Keyboard/window layout and VirtualizedList fill events can precede their
    // layout callbacks. They must not be mistaken for a reader scrolling away.
    if (viewportHeight && Math.abs(height - viewportHeight) > 1) return;
    if (contentHeight && Math.abs(metrics.contentSize.height - contentHeight) > 1) return;
    if (!dragging && !momentum && now() > intentUntil) return;
    following = metrics.contentSize.height - metrics.contentOffset.y - height < 90;
  };

  return {
    scope,
    shouldFollow: () => following,
    measureViewport(height: number) {
      if (Number.isFinite(height) && height > 0) viewportHeight = height;
      return following;
    },
    measureContent(height: number) {
      if (Number.isFinite(height) && height >= 0) contentHeight = height;
      return following;
    },
    observe,
    beginDrag(metrics: ScrollMetrics) { dragging = true; observe(metrics); },
    endDrag(metrics: ScrollMetrics) { observe(metrics); dragging = false; },
    beginMomentum() { momentum = true; },
    endMomentum(metrics: ScrollMetrics) { observe(metrics); momentum = false; },
    // RN Web wheel and keyboard scrolling do not emit native drag callbacks.
    noteUserIntent() { intentUntil = now() + 500; },
    followLatest() {
      following = true;
      dragging = false;
      momentum = false;
      intentUntil = -Infinity;
    },
  };
}
