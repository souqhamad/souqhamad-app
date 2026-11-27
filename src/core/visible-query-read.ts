import type { QueryClient, QueryKey } from "@tanstack/react-query";

/** A hidden reader must not abort a GET still used by another visible reader. */
export function cancelUnusedQueryRead(client: QueryClient, queryKey: QueryKey) {
  const query = client.getQueryCache().find({ queryKey, exact: true });
  if (!query || query.isActive() || query.state.fetchStatus === "idle") return Promise.resolve();
  return client.cancelQueries({ predicate: candidate => candidate === query });
}

/** Imperative refetch/fetchNextPage bypass enabled in TanStack Query. Keep a
 * hidden mutation callback from starting a GET, while retaining invalidation
 * for the next visible reader. A different visible reader may still need it.
 */
export function runVisibleQueryRead<T>(client: QueryClient, queryHash: string, active: boolean, read: () => Promise<T>, skipped: T): Promise<T> {
  const query = client.getQueryCache().get(queryHash);
  if (active && query?.isActive()) return read();
  if (query) void client.invalidateQueries({ predicate: candidate => candidate === query, refetchType: "none" });
  return Promise.resolve(skipped);
}
