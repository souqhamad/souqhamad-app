import assert from "node:assert/strict";
import test from "node:test";
import { advanceToolbarFollow, boundedFeedOffset, clampToolbar, consumeToolbarIntent, manualFeedOffset, retainedCategoryRows, settleToolbar, toolbarMotionDuration, TOOLBAR_CHROME, TOOLBAR_MAX_SPEED } from "../src/features/marketplace/toolbar-motion.ts";

test("continuous following stays bounded in either direction at different display rates", () => {
  for (const interval of [1000 / 60, 1000 / 90, 1000 / 120, 250]) {
    for (const [start, target] of [[0, 136], [136, 0]]) {
      let position = start;
      for (let frame = 0; frame < 250; frame++) {
        const next = advanceToolbarFollow(position, target, interval);
        assert.ok(next >= Math.min(start, target) && next <= Math.max(start, target), "Must not overshoot");
        assert.ok(Math.abs(next - position) <= TOOLBAR_MAX_SPEED * Math.min(64, interval) / 1000 + 0.25, "A delayed frame must not cause a jump");
        assert.ok(Math.abs(target - next) <= Math.abs(target - position), "Must approach the latest goal");
        position = next;
      }
      assert.equal(position, target);
    }
  }
});

test("continuous following has the same speed at 60 Hz and 120 Hz before settling", () => {
  const simulate = hz => {
    let position = 0;
    for (let frame = 0; frame < hz / 10; frame++) position = advanceToolbarFollow(position, 80, 1000 / hz);
    return position;
  };
  assert.ok(Math.abs(simulate(60) - simulate(120)) < 1);
  assert.equal(advanceToolbarFollow(50, 100, 0), 50);
});

test("manual movement at feed start lets the first card follow the visible toolbar", () => {
  for (const collapse of [0, 30, 90, 136, 60, 0]) {
    assert.equal(manualFeedOffset(0, 0, collapse, true), collapse);
    const firstCard = 136 + 40 + TOOLBAR_CHROME - manualFeedOffset(0, 0, collapse, true);
    assert.equal(firstCard, 186 - collapse);
  }
  assert.equal(manualFeedOffset(136, 136, 0, true), 0);
});
test("manual movement deep in the feed preserves the same visible card anchor", () => {
  const startOffset = 1000;
  const startCollapse = 45;
  const header = 250;
  const item = 1300;
  const before = header + item - startOffset;
  for (const collapse of [0, 20, 45, 110, 136]) {
    const offset = manualFeedOffset(startOffset, startCollapse, collapse, false);
    assert.equal(header + item - offset, before);
  }
  assert.equal(manualFeedOffset(40, 0, 70, false), 40);
});
test("elastic overscroll and short feeds cannot change the logical toolbar offset", () => {
  assert.equal(boundedFeedOffset(-70, 2000, 700), 0);
  assert.equal(boundedFeedOffset(1500, 2000, 700), 1300);
  assert.equal(boundedFeedOffset(100, 300, 700), 0);
  assert.equal(boundedFeedOffset(850, 2000, 700), 850);
});
test("direction and release speed settle only the tools, retaining one or two category rows", () => {
  assert.equal(settleToolbar(20, 136, -600), 136);
  assert.equal(settleToolbar(120, 136, 600), 0);
  assert.equal(settleToolbar(60, 136, 0), 0);
  assert.equal(settleToolbar(90, 136, 0), 136);
  assert.deepEqual([1, 2, 3, 4].map(retainedCategoryRows), [1, 2, 2, 2]);
  assert.equal(clampToolbar(-50, 136), 0);
  assert.equal(clampToolbar(500, 136), 136);
  assert.equal(clampToolbar(NaN, 136), 0);
});

test("small alternating scroll deltas cannot accumulate a false toolbar direction", () => {
  let direction = 0;
  let pending = 0;
  for (let index = 0; index < 20; index++) {
    for (const delta of [6, -6]) {
      const next = consumeToolbarIntent(direction, pending, delta);
      assert.equal(next.delta, 0);
      assert.equal(next.direction, 0);
      assert.equal(next.reversed, false);
      direction = next.direction;
      pending = next.pending;
    }
  }
  assert.equal(pending, 0);
});

test("clear accumulated movement confirms a direction and an opposing movement must cross its own threshold", () => {
  const pending = consumeToolbarIntent(0, 0, 8);
  assert.equal(pending.delta, 0);
  const forward = consumeToolbarIntent(pending.direction, pending.pending, 6);
  assert.equal(forward.direction, 1);
  assert.equal(forward.delta, 14);
  assert.equal(forward.pending, 0);
  const smallReverse = consumeToolbarIntent(forward.direction, forward.pending, -6);
  assert.equal(smallReverse.direction, 1);
  assert.equal(smallReverse.delta, 0);
  const reverse = consumeToolbarIntent(smallReverse.direction, smallReverse.pending, -8);
  assert.equal(reverse.direction, -1);
  assert.equal(reverse.delta, -14);
  assert.equal(reverse.reversed, true);
  assert.equal(reverse.pending, 0);
});

test("backtracking consumes the pending reversal before extending the current slide", () => {
  const uncertainty = consumeToolbarIntent(1, 0, -10);
  assert.equal(uncertainty.delta, 0);
  const partlyRecovered = consumeToolbarIntent(uncertainty.direction, uncertainty.pending, 6);
  assert.equal(partlyRecovered.delta, 0);
  assert.equal(partlyRecovered.pending, -4);
  const resumed = consumeToolbarIntent(partlyRecovered.direction, partlyRecovered.pending, 9);
  assert.equal(resumed.direction, 1);
  assert.equal(resumed.pending, 0);
  assert.equal(resumed.delta, 5, "Only movement beyond the canceled reverse may extend the old goal");
  assert.equal(resumed.reversed, false);
});

test("toolbar slide duration keeps quadratic ease-out speed bounded even for taller tools", () => {
  for (const [from, to] of [[0, 6], [0, 136], [160, 0], [40, 320], [320, 40]]) {
    const duration = toolbarMotionDuration(from, to);
    assert.ok(duration >= 320, "Even a short slide should have a calm minimum duration");
    const peakSpeed = 2 * Math.abs(to - from) / (duration / 1000);
    assert.ok(peakSpeed <= 360 + 0.001, "Quadratic ease-out must not exceed the automatic speed cap");
  }
});
