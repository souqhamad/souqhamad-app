import { useCallback, useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { useIsFocused } from "expo-router";
import {
  useQuery, useInfiniteQuery, useQueryClient, hashKey,
  type DefaultError, type InfiniteData, type QueryKey,
  type UseQueryOptions, type UseInfiniteQueryOptions,
} from "@tanstack/react-query";
import { cancelUnusedQueryRead, runVisibleQueryRead } from "./visible-query-read";

const subscribe = (notify: () => void) => {
  const listener = AppState.addEventListener("change", notify);
  return () => listener.remove();
};
const appActive = () => AppState.currentState === "active";
const serverActive = () => true;

export function useScreenActive() {
  const focused = useIsFocused();
  const active = useSyncExternalStore(subscribe, appActive, serverActive);
  return focused && active;
}

function useReadCancellation(queryKey: QueryKey, enabled: boolean) {
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled) void cancelUnusedQueryRead(client, queryKey);
  }, [client, queryKey, enabled]);
}

function useVisibleRead<TKey extends QueryKey>(queryKey: TKey, hash?: (key: TKey) => string) {
  const client = useQueryClient();
  const queryHash = (hash ?? hashKey)(queryKey);
  return useCallback(<T,>(read: () => Promise<T>, skipped: T) =>
    runVisibleQueryRead(client, queryHash, appActive(), read, skipped), [client, queryHash]);
}

/** GET queries only: hiding a screen never cancels writes or image transfers. */
export function useVisibleQuery<T>(options: UseQueryOptions<T> & { enabled?: boolean }) {
  const visible = useScreenActive();
  const enabled = visible && options.enabled !== false;
  const result = useQuery({ ...options, enabled });
  useReadCancellation(options.queryKey, enabled);
  const read = useVisibleRead(options.queryKey, options.queryKeyHashFn);
  return { ...result, refetch: useCallback((...args: Parameters<typeof result.refetch>) =>
    read(() => result.refetch(...args), result), [read, result]) };
}

export function useVisibleInfiniteQuery<
  TQueryFnData, TError = DefaultError, TData = InfiniteData<TQueryFnData>,
  TQueryKey extends QueryKey = QueryKey, TPageParam = unknown,
>(options: UseInfiniteQueryOptions<TQueryFnData, TError, TData, TQueryKey, TPageParam> & { enabled?: boolean }) {
  const visible = useScreenActive();
  const enabled = visible && options.enabled !== false;
  const result = useInfiniteQuery({ ...options, enabled });
  useReadCancellation(options.queryKey, enabled);
  const read = useVisibleRead(options.queryKey, options.queryKeyHashFn);
  return {
    ...result,
    refetch: useCallback((...args: Parameters<typeof result.refetch>) => read(() => result.refetch(...args), result), [read, result]),
    fetchNextPage: useCallback((...args: Parameters<typeof result.fetchNextPage>) => read(() => result.fetchNextPage(...args), result), [read, result]),
    fetchPreviousPage: useCallback((...args: Parameters<typeof result.fetchPreviousPage>) => read(() => result.fetchPreviousPage(...args), result), [read, result]),
  };
}
