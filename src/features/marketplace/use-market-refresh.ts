import { useCallback, useEffect, useRef, useState } from "react";

/** Background query updates must not activate the native pull-to-refresh control. */
export function useMarketRefresh({ refreshListings, refreshBootstrap }: {
  refreshListings: () => Promise<unknown>;
  refreshBootstrap: () => Promise<unknown>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const onRefresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    setRefreshing(true);
    // Each query retains its own error state; keep the gesture active until both settle.
    await Promise.allSettled([
      Promise.resolve().then(refreshListings),
      Promise.resolve().then(refreshBootstrap),
    ]);
    pending.current = false;
    if (mounted.current) setRefreshing(false);
  }, [refreshListings, refreshBootstrap]);

  return { refreshing, onRefresh };
}
