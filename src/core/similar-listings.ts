import type { Listing } from "./types";

export const similarListingsLimit = 20;

/** Validate the existing listing endpoint's similar view; ranking stays on the server. */
export function parseSimilarListings(value: unknown, listingId: string): Listing[] {
  if (!value || typeof value !== "object" || !("listings" in value) || !Array.isArray(value.listings))
    throw new Error("استجابة الإعلانات المشابهة غير متاحة حاليًا.");
  const rows: Listing[] = [];
  const seen = new Set([listingId]);
  for (const candidate of value.listings) {
    if (!candidate || typeof candidate !== "object" ||
      typeof candidate.id !== "string" || !candidate.id ||
      typeof candidate.sellerId !== "string" || typeof candidate.category !== "string" ||
      typeof candidate.status !== "string" || !Array.isArray(candidate.images) ||
      candidate.images.some((image: unknown) => !image || typeof image !== "object" || !("status" in image) || typeof image.status !== "string") ||
      !candidate.attributes || typeof candidate.attributes !== "object" || Array.isArray(candidate.attributes))
      throw new Error("استجابة الإعلانات المشابهة غير متاحة حاليًا.");
    if (candidate.status !== "published" || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    rows.push(candidate as Listing);
    if (rows.length === similarListingsLimit) break;
  }
  return rows;
}
