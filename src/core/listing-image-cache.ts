import type { QueryClient, QueryFilters } from "@tanstack/react-query";
import type { Listing } from "./types";

/** Apply the server's image ordering before returning to a cached detail page. */
export function syncListingImageCaches(client: QueryClient, listing: Listing, options: { refetch?: boolean } = {}) {
  const detailKey = ["listing", listing.id];
  const ownedKey = ["owned-listing", listing.sellerId, listing.id];
  // Detail keys include legacy entries and per-screen visit IDs. Similar
  // queries share this prefix but contain arrays, so leave that family alone.
  const detailQueries: QueryFilters = {
    queryKey: detailKey,
    predicate: query => query.queryKey[2] !== "similar",
  };
  void client.cancelQueries(detailQueries);
  void client.cancelQueries({ queryKey: ownedKey, exact: true });
  if (listing.status === "published") {
    const detailData = {
      listing: { ...listing, images: listing.images.filter(image => image.status === "approved") },
    };
    client.setQueriesData(detailQueries, () => detailData);
    client.setQueryData(detailKey, detailData);
  } else {
    client.removeQueries(detailQueries);
  }
  client.setQueryData(ownedKey, { listing });
  for (const queryKey of [
    ["marketplace"], ["my-listings"], ["seller", listing.sellerId],
    ["account", listing.sellerId, "favorites"],
  ]) void client.invalidateQueries({ queryKey, ...(options.refetch === false ? { refetchType: "none" as const } : {}) });
}
