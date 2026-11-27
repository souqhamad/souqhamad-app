type ListingImageSources = {
  originalUrl?: string | null;
  displayUrl?: string | null;
  thumbnailUrl?: string | null;
};

/** Prefer the retained display derivative on every viewing surface. Legacy records
 * still fall back to their original/thumbnail URL without inventing CDN paths. */
export function getListingImageSources(
  image: ListingImageSources | null | undefined,
  resolve: (url?: string | null) => string | undefined,
) {
  const original = resolve(image?.originalUrl);
  const display = resolve(image?.displayUrl);
  const thumbnail = resolve(image?.thumbnailUrl);
  return {
    source: display || original || thumbnail,
    previewSource: display || thumbnail || original,
    thumbnailSource: thumbnail,
  };
}

/** Cards start with the smallest server derivative and fall back on real load errors. */
export function getListingCardImageSources(
  image: ListingImageSources | null | undefined,
  resolve: (url?: string | null) => string | undefined,
) {
  return [...new Set([
    resolve(image?.thumbnailUrl), resolve(image?.displayUrl), resolve(image?.originalUrl),
  ].filter((url): url is string => !!url))];
}
