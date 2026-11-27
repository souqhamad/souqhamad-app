import { useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet } from "react-native";
import { Image } from "expo-image";
import { ListingCardRecoveryContext } from "./listing-card-recovery";

type ListingCardImageProps = {
  sources: readonly string[];
  fallback: ReactNode;
  accessibilityLabel?: string;
};

/** A broken thumbnail can fall back to another server-provided derivative. */
export function ListingCardImage(props: ListingCardImageProps) {
  const sources = [...new Set(props.sources.filter(Boolean))];
  return <ListingCardImageContent key={JSON.stringify(sources)} {...props} sources={sources} />;
}

function ListingCardImageContent({ sources, fallback, accessibilityLabel }: ListingCardImageProps) {
  const recovery = useContext(ListingCardRecoveryContext);
  const [selection, setSelection] = useState({ index: 0, attempt: 0, automaticRetry: 0 });
  const { index, attempt, automaticRetry } = selection;
  const previousRecovery = useRef(recovery);
  const appliedNetworkRevision = useRef(recovery.networkRevision);
  const displayedKey = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const source = sources[index];
  const imageKey = source ? `${source}:${attempt}` : undefined;
  const currentImageKey = useRef(imageKey);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { currentImageKey.current = imageKey; }, [imageKey]);
  useLayoutEffect(() => {
    const previous = previousRecovery.current;
    previousRecovery.current = recovery;
    if (!recovery.active) return;
    const reconnected = appliedNetworkRevision.current !== recovery.networkRevision;
    appliedNetworkRevision.current = recovery.networkRevision;
    if (!reconnected && previous.active && recovery.revision === previous.revision) return;
    setSelection(current => {
      if (!sources.length) return current;
      const pending = displayedKey.current !== `${sources[current.index]}:${current.attempt}`;
      if (current.index < sources.length && (!reconnected || !pending)) return current;
      return { index: 0, attempt: current.attempt + 1, automaticRetry: 0 };
    });
  }, [recovery, sources]);
  useLayoutEffect(() => {
    if (source || !sources.length || automaticRetry > 0) return;
    const timer = setTimeout(() => {
      if (mounted.current) setSelection(current => current.index === sources.length && current.attempt === attempt && current.automaticRetry === 0
        ? { index: 0, attempt: current.attempt + 1, automaticRetry: 1 }
        : current);
    }, 350);
    return () => clearTimeout(timer);
  }, [source, sources.length, attempt, automaticRetry]);
  if (!source) return fallback;
  return <Image
    key={imageKey}
    source={source}
    accessibilityLabel={accessibilityLabel}
    style={StyleSheet.absoluteFill}
    contentFit="cover"
    cachePolicy="memory-disk"
    transition={180}
    onDisplay={() => {
      if (mounted.current && currentImageKey.current === imageKey) displayedKey.current = imageKey;
    }}
    onError={() => {
      if (mounted.current) setSelection(current => current.index === index && current.attempt === attempt
        ? { ...current, index: current.index + 1 } : current);
    }}
  />;
}
