/** Pan limits for a centered image rendered with contentFit="contain". */
export function getGalleryPanBounds(
  viewportWidth: number,
  viewportHeight: number,
  imageWidth: number,
  imageHeight: number,
  scale: number,
) {
  "worklet";
  if (
    ![viewportWidth, viewportHeight, imageWidth, imageHeight, scale].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  ) {
    return { maxX: 0, maxY: 0 };
  }
  const fit = Math.min(viewportWidth / imageWidth, viewportHeight / imageHeight);
  return {
    maxX: Math.max(0, (imageWidth * fit * scale - viewportWidth) / 2),
    maxY: Math.max(0, (imageHeight * fit * scale - viewportHeight) / 2),
  };
}

/** Native horizontal offsets can overshoot either end during a page gesture. */
export function getGalleryPageIndex(offset: number, width: number, count: number) {
  if (!Number.isFinite(offset) || !Number.isFinite(width) || width <= 0 || count <= 0)
    return 0;
  return Math.min(count - 1, Math.max(0, Math.round(offset / width)));
}

/** Warm only the immediate previews, rather than every full-size listing image. */
export function getGalleryNeighbourIndexes(index: number, count: number) {
  return [index - 1, index + 1].filter((value) => value >= 0 && value < count);
}

export type GallerySelection = Readonly<{ id?: string; index: number }>;

/** Preserve the selected photo when refreshed data removes or reorders rows. */
export function resolveGallerySelection(
  images: readonly { id: string }[],
  previous: GallerySelection,
): GallerySelection {
  if (!images.length) return previous.id === undefined && previous.index === 0
    ? previous : { index: 0 };
  const retainedIndex = previous.id === undefined ? -1 : images.findIndex(image => image.id === previous.id);
  const fallbackIndex = Number.isFinite(previous.index) ? Math.trunc(previous.index) : 0;
  const index = retainedIndex >= 0 ? retainedIndex : Math.min(images.length - 1, Math.max(0, fallbackIndex));
  const id = images[index].id;
  return previous.id === id && previous.index === index ? previous : { id, index };
}
