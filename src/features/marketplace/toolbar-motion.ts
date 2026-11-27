// Two borders plus eight points of inner padding. The first card starts at
// the toolbar's bottom edge, with no additional spacer between the two.
export const TOOLBAR_CHROME = 10;
export const TOOLBAR_DIRECTION_THRESHOLD = 14;
export const TOOLBAR_MAX_SPEED = 360;

export function advanceToolbarFollow(current: number, target: number, elapsed: number) {
  "worklet";
  const distance = target - current;
  if (Math.abs(distance) <= 0.25) return target;
  const seconds = Math.max(0, Math.min(64, elapsed)) / 1000;
  const step = Math.min(Math.abs(distance), TOOLBAR_MAX_SPEED * seconds,
    Math.abs(distance) * (1 - Math.exp(-seconds / 0.12)));
  return current + Math.sign(distance) * step;
}

export function toolbarMotionDuration(from: number, to: number) {
  "worklet";
  // easeOut(quad) has peak speed 2 * distance / duration.
  return Math.max(320, Math.abs(to - from) * 2000 / TOOLBAR_MAX_SPEED);
}

export function consumeToolbarIntent(direction: number, pending: number, delta: number) {
  "worklet";
  if (!Number.isFinite(delta) || delta === 0) return { direction, pending, delta: 0, reversed: false };
  const accumulated = pending + delta;
  const nextDirection = Math.sign(accumulated);
  if (nextDirection !== direction && Math.abs(accumulated) < TOOLBAR_DIRECTION_THRESHOLD) {
    return { direction, pending: accumulated, delta: 0, reversed: false };
  }
  return { direction: nextDirection || direction, pending: 0, delta: accumulated, reversed: direction !== 0 && nextDirection !== 0 && direction !== nextDirection };
}
export function clampToolbar(value: number, maximum: number) {
  "worklet";
  return Math.max(0, Math.min(Math.max(0, maximum), Number.isFinite(value) ? value : 0));
}
export function manualFeedOffset(startOffset: number, startCollapse: number, collapse: number, atTop: boolean) {
  "worklet";
  return atTop ? Math.max(0, startOffset + collapse - startCollapse) : startOffset;
}
export function boundedFeedOffset(value: number, contentHeight: number, viewportHeight: number) {
  "worklet";
  return clampToolbar(value, contentHeight - viewportHeight);
}
export function settleToolbar(collapse: number, maximum: number, velocityY: number) {
  "worklet";
  if (Math.abs(velocityY) > 450) return velocityY < 0 ? maximum : 0;
  return collapse >= maximum / 2 ? maximum : 0;
}
export function retainedCategoryRows(count: number) {
  return Math.max(1, Math.min(2, count));
}
