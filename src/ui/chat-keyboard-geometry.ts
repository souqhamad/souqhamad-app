export type ChatWindowFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ChatKeyboardFrame = {
  screenX: number;
  screenY: number;
  width: number;
  height: number;
};

/** Reserve only the keyboard overlap left after the native window has resized. */
export function getChatKeyboardInsets(
  viewport: ChatWindowFrame,
  keyboard: ChatKeyboardFrame | null,
  safeAreaBottom: number,
) {
  const safeBottom = Number.isFinite(safeAreaBottom)
    ? Math.max(0, safeAreaBottom)
    : 0;
  const closed = { overlap: 0, safeBottom };
  if (
    !keyboard ||
    !Object.values(viewport).every(Number.isFinite) ||
    !Object.values(keyboard).every(Number.isFinite) ||
    viewport.width <= 0 || viewport.height <= 0 ||
    keyboard.width <= 0 || keyboard.height <= 0
  ) return closed;

  const bottom = viewport.y + viewport.height;
  if (
    keyboard.screenX >= viewport.x + viewport.width ||
    keyboard.screenX + keyboard.width <= viewport.x ||
    // Android reports IME height without the navigation bar. Allow that safe
    // area when distinguishing a docked keyboard from a floating one.
    keyboard.screenY + keyboard.height < bottom - safeBottom - 1
  ) return closed;

  return {
    overlap: Math.min(viewport.height, Math.max(0, bottom - keyboard.screenY)),
    // The IME already protects the home indicator/navigation area.
    safeBottom: 0,
  };
}
