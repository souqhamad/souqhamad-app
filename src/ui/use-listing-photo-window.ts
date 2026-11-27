import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { getListingPhotoWindow } from "./listing-photo-window";

export function useListingPhotoWindow(count: number, scope: string) {
  const layout = useRef({ top: null as number | null, scrollY: 0, height: 0 });
  const [range, setRange] = useState(() => getListingPhotoWindow(count, null, 0, 0));
  const update = useCallback(() => {
    const { top, scrollY, height } = layout.current;
    const next = getListingPhotoWindow(count, top, scrollY, height);
    setRange(previous => previous.first === next.first && previous.last === next.last ? previous : next);
  }, [count]);
  useLayoutEffect(() => {
    layout.current = { top: null, scrollY: 0, height: 0 };
  }, [scope]);
  useLayoutEffect(update, [scope, update]);
  return {
    range,
    onPhotosLayout: useCallback((event: LayoutChangeEvent) => {
      layout.current.top = event.nativeEvent.layout.y;
      update();
    }, [update]),
    onViewportLayout: useCallback((event: LayoutChangeEvent) => {
      layout.current.height = event.nativeEvent.layout.height;
      update();
    }, [update]),
    onScroll: useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
      layout.current.scrollY = event.nativeEvent.contentOffset.y;
      update();
    }, [update]),
  };
}
