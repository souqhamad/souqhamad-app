export const listingPhotoHeight = 210;
export const listingPhotoGap = 10;

/** Keep the visible photos and one neighbouring row ready, without moving frames. */
export function getListingPhotoWindow(
  count: number,
  photosTop: number | null,
  scrollY: number,
  viewportHeight: number,
) {
  if (count <= 0) return { first: 0, last: -1 };
  if (photosTop === null || !Number.isFinite(viewportHeight) || viewportHeight <= 0)
    return { first: 0, last: 0 };
  const stride = listingPhotoHeight + listingPhotoGap;
  const top = Math.max(0, Number.isFinite(scrollY) ? scrollY : 0) - photosTop;
  const bottom = top + viewportHeight;
  const totalHeight = count * stride - listingPhotoGap;
  if (bottom + stride <= 0 || top - stride >= totalHeight)
    return { first: 0, last: -1 };
  return {
    first: Math.min(count - 1, Math.max(0, Math.floor((top - stride) / stride))),
    last: Math.min(count - 1, Math.max(0, Math.floor((bottom + stride) / stride))),
  };
}
