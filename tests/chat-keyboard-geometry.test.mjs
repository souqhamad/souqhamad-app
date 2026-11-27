import test from "node:test";
import assert from "node:assert/strict";
import { getChatKeyboardInsets } from "../src/ui/chat-keyboard-geometry.ts";

const viewport = { x: 0, y: 120, width: 390, height: 724 };
const keyboard = { screenX: 0, screenY: 520, width: 390, height: 324 };

test("a header outside the chat does not reduce the required keyboard overlap", () => {
  assert.deepEqual(getChatKeyboardInsets(viewport, keyboard, 34), {
    overlap: 324, safeBottom: 0,
  });
  assert.deepEqual(getChatKeyboardInsets({ ...viewport, y: 168, height: 676 }, keyboard, 34), {
    overlap: 324, safeBottom: 0,
  });
});

test("Android adjustResize consumes the keyboard height exactly once", () => {
  const resized = { ...viewport, height: 400 };
  assert.deepEqual(getChatKeyboardInsets(resized, keyboard, 24), {
    overlap: 0, safeBottom: 0,
  });
  assert.deepEqual(getChatKeyboardInsets({ ...resized, height: 424 }, keyboard, 24), {
    overlap: 24, safeBottom: 0,
  });
});

test("Android keyboard metrics may exclude the bottom system navigation bar", () => {
  assert.deepEqual(getChatKeyboardInsets(viewport, { ...keyboard, height: 300 }, 24), {
    overlap: 324, safeBottom: 0,
  });
});

test("keyboard height changes and resized windows use the current geometry", () => {
  const emojiKeyboard = { ...keyboard, screenY: 450, height: 394 };
  assert.equal(getChatKeyboardInsets(viewport, emojiKeyboard, 34).overlap, 394);
  assert.equal(getChatKeyboardInsets({ ...viewport, height: 330 }, emojiKeyboard, 34).overlap, 0);
  assert.equal(getChatKeyboardInsets({ x: 0, y: 80, width: 844, height: 310 },
    { screenX: 0, screenY: 210, width: 844, height: 180 }, 21).overlap, 180);
});

test("closed and hardware keyboards restore only the actual bottom safe area", () => {
  assert.deepEqual(getChatKeyboardInsets(viewport, null, 34), { overlap: 0, safeBottom: 34 });
  assert.deepEqual(getChatKeyboardInsets(viewport, { ...keyboard, height: 0 }, 24), {
    overlap: 0, safeBottom: 24,
  });
  assert.deepEqual(getChatKeyboardInsets(viewport, null, 0), { overlap: 0, safeBottom: 0 });
});

test("floating keyboards and keyboards in a different horizontal window do not lift the chat", () => {
  assert.deepEqual(getChatKeyboardInsets(viewport,
    { ...keyboard, screenY: 300, height: 200 }, 34), { overlap: 0, safeBottom: 34 });
  assert.deepEqual(getChatKeyboardInsets(viewport,
    { ...keyboard, screenX: 500 }, 34), { overlap: 0, safeBottom: 34 });
});

test("unmeasured or invalid frames cannot introduce an oversized keyboard gap", () => {
  assert.deepEqual(getChatKeyboardInsets({ ...viewport, height: 0 }, keyboard, 34), {
    overlap: 0, safeBottom: 34,
  });
  assert.deepEqual(getChatKeyboardInsets(viewport, { ...keyboard, screenY: NaN }, -5), {
    overlap: 0, safeBottom: 0,
  });
  assert.equal(getChatKeyboardInsets(viewport, { ...keyboard, screenY: -500, height: 1344 }, 34).overlap,
    viewport.height);
});
