import type { ChatKeyboardFrame, ChatWindowFrame } from "./chat-keyboard-geometry";

function validFrame(frame: ChatWindowFrame) {
  return !!frame && [frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) &&
    frame.width > 0 && frame.height > 0 &&
    Number.isFinite(frame.x + frame.width) && Number.isFinite(frame.y + frame.height);
}

/** Use measured window coordinates, whether or not Android already resized it. */
export function getFormFieldScrollOffset(
  viewport: ChatWindowFrame,
  field: ChatWindowFrame,
  currentOffset: number,
  keyboard: ChatKeyboardFrame | null,
  gap = 12,
): number {
  const offset = Number.isFinite(currentOffset) ? Math.max(0, currentOffset) : 0;
  if (!validFrame(viewport) || !validFrame(field)) return offset;
  const left = Math.max(viewport.x, field.x);
  const right = Math.min(viewport.x + viewport.width, field.x + field.width);
  if (left >= right) return offset;
  const bottom = viewport.y + viewport.height;
  const margin = Number.isFinite(gap) ? Math.max(0, gap) : 0;
  const within = (visibleBottom: number) => {
    const height = visibleBottom - viewport.y;
    if (height <= 0) return offset;
    const padding = Math.min(margin, height / 4);
    let delta = 0;
    if (field.height > height - 2 * padding) {
      // An oversized multiline input cannot fit. Keep its first line visible,
      // rather than moving its entire bottom above the IME and losing the top.
      if (field.y < viewport.y || field.y >= visibleBottom)
        delta = field.y - viewport.y - padding;
    } else if (field.y < viewport.y + padding) {
      delta = field.y - viewport.y - padding;
    } else if (field.y + field.height > visibleBottom - padding) {
      delta = field.y + field.height - visibleBottom + padding;
    }
    const result = offset + delta;
    return Number.isFinite(result) ? Math.max(0, result) : offset;
  };
  const ordinary = within(bottom);
  if (!keyboard || !validFrame({ x: keyboard.screenX, y: keyboard.screenY, width: keyboard.width, height: keyboard.height }) ||
    keyboard.screenX >= right || keyboard.screenX + keyboard.width <= left) return ordinary;
  const keyboardBottom = keyboard.screenY + keyboard.height;
  const coversField = (top: number) => Math.max(top, viewport.y) < Math.min(keyboardBottom, bottom) &&
    Math.min(top + field.height, bottom) > Math.max(keyboard.screenY, viewport.y);
  // Floating keyboards matter only where they cover this field, including its
  // position after ordinary scrolling. A separate horizontal window is ignored.
  const docked = keyboardBottom >= bottom - 1;
  const projectedTop = field.y - (ordinary - offset);
  return docked || coversField(field.y) || coversField(projectedTop)
    ? within(Math.min(bottom, keyboard.screenY)) : ordinary;
}
