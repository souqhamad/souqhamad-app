import assert from "node:assert/strict";
import test from "node:test";
import { getFormFieldScrollOffset } from "../src/ui/form-keyboard-geometry.ts";

const viewport = { x: 0, y: 100, width: 390, height: 744 };
const keyboard = { screenX: 0, screenY: 520, width: 390, height: 324 };
const field = (y, height = 50, x = 16, width = 358) => ({ x, y, width, height });

test("a focused lower field clears the keyboard with room for typing", () => {
  const next = getFormFieldScrollOffset(viewport, field(610), 200, keyboard);
  assert.equal(next, 352);
  assert.equal(660 - (next - 200), keyboard.screenY - 12);
});

test("Android resized and unresized windows require the same correction exactly once", () => {
  const resized = { ...viewport, height: 420 };
  assert.equal(getFormFieldScrollOffset(viewport, field(610), 200, keyboard), 352);
  assert.equal(getFormFieldScrollOffset(resized, field(610), 200, keyboard), 352);
  assert.equal(getFormFieldScrollOffset(resized, field(610), 200, null), 352);
});

test("a fixed header uses its measured viewport top and can reveal a field above it", () => {
  assert.equal(getFormFieldScrollOffset(viewport, field(80), 200, keyboard), 168);
  const tallerHeader = { ...viewport, y: 160, height: 684 };
  assert.equal(getFormFieldScrollOffset(tallerHeader, field(140), 200, keyboard), 168);
  assert.equal(getFormFieldScrollOffset(viewport, field(80), 10, keyboard), 0);
});

test("already visible fields do not move when focus or layout repeats", () => {
  assert.equal(getFormFieldScrollOffset(viewport, field(300), 200, keyboard), 200);
  assert.equal(getFormFieldScrollOffset(viewport, field(112), 200, keyboard), 200);
  assert.equal(getFormFieldScrollOffset(viewport, field(458), 200, keyboard), 200);
});

test("oversized multiline fields retain a visible first line without forcing their bottom into view", () => {
  assert.equal(getFormFieldScrollOffset(viewport, field(200, 600), 200, keyboard), 200);
  assert.equal(getFormFieldScrollOffset(viewport, field(50, 600), 200, keyboard), 138);
  assert.equal(getFormFieldScrollOffset(viewport, field(530, 600), 200, keyboard), 618);
});

test("hardware or closed keyboards use the actual available viewport", () => {
  assert.equal(getFormFieldScrollOffset(viewport, field(700), 200, null), 200);
  assert.equal(getFormFieldScrollOffset(viewport, field(810), 200, null), 228);
  assert.equal(getFormFieldScrollOffset(viewport, field(810), 200, { ...keyboard, height: 0 }), 228);
});

test("floating keyboards only displace covered fields, not fields beside or below them", () => {
  const floating = { screenX: 100, screenY: 300, width: 200, height: 200 };
  assert.equal(getFormFieldScrollOffset(viewport, field(350, 50, 120, 100), 200, floating), 312);
  assert.equal(getFormFieldScrollOffset(viewport, field(550), 200, floating), 200);
  assert.equal(getFormFieldScrollOffset(viewport, field(350, 50, 0, 50), 200, floating), 200);
});

test("normal scrolling must not place a lower field behind a floating keyboard", () => {
  const floating = { screenX: 100, screenY: 650, width: 200, height: 150 };
  const next = getFormFieldScrollOffset(viewport, field(900, 100), 200, floating);
  assert.equal(next, 562);
  assert.equal(1000 - (next - 200), 638);
  assert.equal(getFormFieldScrollOffset(viewport, field(900, 20), 200, floating), 288);
});

test("keyboards and fields in another horizontal window cannot move this form", () => {
  assert.equal(getFormFieldScrollOffset(viewport, field(300), 200, { ...keyboard, screenX: 500 }), 200);
  assert.equal(getFormFieldScrollOffset(viewport, field(610, 50, 500, 100), 200, keyboard), 200);
  assert.equal(getFormFieldScrollOffset(viewport, field(350, 50, 350, 100), 200,
    { screenX: 400, screenY: 300, width: 100, height: 200 }), 200);
});

test("invalid or unmeasured geometry cannot invent a keyboard gap", () => {
  for (const bad of [
    { ...viewport, height: 0 }, { ...viewport, width: 0 }, { ...viewport, y: NaN },
  ]) assert.equal(getFormFieldScrollOffset(bad, field(610), 200, keyboard), 200);
  assert.equal(getFormFieldScrollOffset(viewport, field(610, 0), 200, keyboard), 200);
  assert.equal(getFormFieldScrollOffset(viewport, field(NaN), 200, keyboard), 200);
  assert.equal(getFormFieldScrollOffset(viewport, field(650), 200, { ...keyboard, screenY: NaN }), 200);
  assert.equal(getFormFieldScrollOffset(viewport, field(300), -10, null), 0);
  assert.equal(getFormFieldScrollOffset(viewport, field(300), NaN, null), 0);
});

test("a keyboard covering every available pixel cannot trigger runaway scrolling", () => {
  assert.equal(getFormFieldScrollOffset(viewport, field(610), 200,
    { screenX: 0, screenY: 20, width: 390, height: 824 }), 200);
});
