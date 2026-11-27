import type { ListingImage } from "../../core/types";
import type { UploadAsset } from "../../core/media";

/** A saved photo replaces its queued tile, while its local preview remains
 * available until the delivery image has actually rendered on this device. */
export function buildEditorImages(
  images: readonly ListingImage[],
  assets: readonly UploadAsset[],
  localPreviews: ReadonlyMap<string, string>,
  uploadId: (uri: string) => string | undefined,
  resolve: (url?: string | null) => string | undefined,
) {
  const savedIds = new Set(images.map(image => image.id));
  return [
    ...images.map(image => {
      const localUri = localPreviews.get(image.id) ?? assets.find(asset => uploadId(asset.uri) === image.id)?.uri;
      const sources = [...new Set([
        resolve(image.displayUrl), resolve(image.thumbnailUrl), resolve(image.originalUrl),
      ].filter((url): url is string => !!url))];
      return { id: image.id, saved: true, primary: image.isPrimary,
        uri: sources[0] ?? localUri ?? "", localUri, sources };
    }),
    ...assets.filter(asset => !savedIds.has(uploadId(asset.uri) ?? "")).map(asset => ({
      id: asset.uri, saved: false, primary: false,
      uri: asset.uri, localUri: asset.uri, sources: [] as string[],
    })),
  ];
}
