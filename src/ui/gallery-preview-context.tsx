import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Image, type ImageRef } from "expo-image";
import { Platform, StyleSheet } from "react-native";
import { fetch as expoFetch } from "expo/fetch";
import { File, Paths } from "expo-file-system";
import { randomUUID } from "expo-crypto";
import { GalleryPreviewCache } from "./gallery-preview-cache";
import { createGalleryPreviewLoader } from "./gallery-preview-loader";

const loadPreview = createGalleryPreviewLoader<ImageRef>({
  cachedPath: url => Image.getCachePathAsync(url),
  fetch: (url, options) => expoFetch(url, options),
  temporaryFile: () => new File(Paths.cache, `listing-preview-${randomUUID()}.image`),
  decode: uri => Image.loadAsync(uri, { maxWidth: 900, maxHeight: 900 }),
  persist: (uri, cacheKey) => Image.writeToCacheAsync(uri, cacheKey),
});
const createCache = () => new GalleryPreviewCache<ImageRef>(loadPreview);
const Context = createContext<GalleryPreviewCache<ImageRef> | null>(null);

function useOwnedCache() {
  const [cache] = useState(createCache);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Keep refs valid through the native view removal and Strict Mode replay.
      void Promise.resolve().then(() => { if (!mounted.current) cache.dispose(); });
    };
  }, [cache]);
  return cache;
}

/** Share decoded previews between detail and modal; released with this listing. */
export function GalleryPreviewProvider({ children }: { children: ReactNode }) {
  const cache = useOwnedCache();
  return <Context.Provider value={cache}>{children}</Context.Provider>;
}

export function useWarmGalleryPreviews(urls: string[]) {
  const cache = useContext(Context);
  const key = JSON.stringify(urls.slice(0, 8));
  useEffect(() => { if (Platform.OS !== "web") cache?.warm(JSON.parse(key) as string[]); }, [cache, key]);
}

export function NativeGalleryPreview({ url, attempt, contentFit, accessibilityLabel, priority = 0, onLoaded, onError, onStalled }: {
  url: string;
  attempt: number;
  priority?: number;
  contentFit: "contain" | "cover";
  accessibilityLabel: string;
  onLoaded: (size: { width: number; height: number }) => void;
  onError: () => void;
  onStalled: () => void;
}) {
  const context = useContext(Context);
  const ownedCache = useOwnedCache();
  const cache = context || ownedCache;
  const subscribe = useCallback((listener: () => void) => cache.subscribe(url, listener, priority), [cache, priority, url]);
  const snapshot = useCallback(() => cache.snapshot(url), [cache, url]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const callbacks = useRef({ onLoaded, onError, onStalled, attempt });
  useLayoutEffect(() => { callbacks.current = { onLoaded, onError, onStalled, attempt }; }, [onLoaded, onError, onStalled, attempt]);
  useEffect(() => { if (attempt) cache.retry(url); }, [attempt, cache, url]);
  // Opening/selecting a failed photo is a new recovery opportunity even when
  // the detail screen still subscribes to the same failed preview.
  useEffect(() => { if (priority > 0) cache.retry(url); }, [cache, priority, url]);
  useEffect(() => {
    if (cache.snapshot(url) !== state) return;
    if (state.status === "error") callbacks.current.onError();
    if (state.status === "stalled") callbacks.current.onStalled();
  }, [cache, state, url]);
  return state.resource ? <Image
    key={`${url}-${attempt}`}
    source={state.resource}
    accessibilityLabel={accessibilityLabel}
    contentFit={contentFit}
    transition={0}
    onDisplay={() => {
      if (mounted.current && callbacks.current.attempt === attempt && cache.snapshot(url).resource === state.resource && state.resource) {
        callbacks.current.onLoaded(state.resource);
      }
    }}
    onError={() => {
      if (mounted.current && callbacks.current.attempt === attempt && cache.snapshot(url).resource === state.resource) {
        callbacks.current.onError();
      }
    }}
    style={StyleSheet.absoluteFill}
  /> : null;
}
