import type { Pagination } from "./types";

export function nextListingPage(pagination: Pagination, currentPage: number) {
  const next = pagination.nextPage;
  return pagination.hasMore !== false && typeof next === "number" &&
    Number.isSafeInteger(next) && next > currentPage
    ? next
    : undefined;
}

export function uniqueListings<T extends { id: string }>(pages: readonly { listings: T[] }[]) {
  const records = new Map<string, T>();
  for (const page of pages) for (const listing of page.listings) records.set(listing.id, listing);
  return [...records.values()];
}
