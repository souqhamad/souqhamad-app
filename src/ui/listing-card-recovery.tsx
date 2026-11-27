import { addNetworkStateListener, getNetworkStateAsync, type NetworkState } from "expo-network";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useScreenActive } from "../core/visible-query";

const NetworkRevisionContext = createContext(0);
export const ListingCardRecoveryContext = createContext({ active: true, revision: 0, networkRevision: 0 });

/** Share one native connection subscription across all lists. */
export function ListingCardNetworkRecoveryProvider({ children }: { children: ReactNode }) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let previous: { online: boolean; type: NetworkState["type"] } | undefined;
    let observedEvent = false;
    let subscribed = true;
    function observe({ isConnected, isInternetReachable, type }: NetworkState) {
      if (!subscribed || (isConnected === undefined && isInternetReachable === undefined)) return;
      const online = isConnected !== false && isInternetReachable !== false;
      const last = previous;
      previous = { online, type };
      if (online && last && (!last.online || (last.type && type && last.type !== type))) {
        setRevision(current => current + 1);
      }
    }
    const subscription = addNetworkStateListener(state => {
      observedEvent = true;
      observe(state);
    });
    void getNetworkStateAsync().then(state => {
      if (!observedEvent) observe(state);
    }).catch(() => {});
    return () => { subscribed = false; subscription.remove(); };
  }, []);
  return <NetworkRevisionContext.Provider value={revision}>{children}</NetworkRevisionContext.Provider>;
}

/** Only the visible list can restart failed images. */
export function ListingCardRecoveryProvider({ revision, children }: { revision: number; children: ReactNode }) {
  const active = useScreenActive();
  const networkRevision = useContext(NetworkRevisionContext);
  const value = useMemo(() => ({ active, revision, networkRevision }), [active, revision, networkRevision]);
  return <ListingCardRecoveryContext.Provider value={value}>{children}</ListingCardRecoveryContext.Provider>;
}
