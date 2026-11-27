import { createThemedStyles, useTheme } from "./theme-context";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, StyleSheet, View } from "react-native";
import {
  GestureDetector,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  useTapGesture,
  type NativeGesture,
} from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Image } from "expo-image";
import { getGalleryPanBounds } from "./gallery-geometry";
import { AppText, Icon, InlineNotice } from "./index";
import { NativeGalleryPreview } from "./gallery-preview-context";
export { GalleryPreviewProvider } from "./gallery-preview-context";

const IMAGE_WAIT_MS = 15000;
type LayerState = { attempt: number; automaticRetries: number; status: "loading" | "loaded" | "stalled" | "error"; size?: { width: number; height: number } };

function useImageLayer(url: string | undefined, enabled: boolean, {
  automaticRetry = true,
  active = false,
  watchdog = true,
}: { automaticRetry?: boolean; active?: boolean; watchdog?: boolean } = {}) {
  const [state, setState] = useState<LayerState>({ attempt: 0, automaticRetries: 0, status: "loading" });
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const attempt = state.attempt;
  const wasActive = useRef(active);
  const display = useRef<{ attempt: number; displayed: boolean; size?: { width: number; height: number } }>({ attempt, displayed: false });
  useLayoutEffect(() => { display.current = { attempt, displayed: false }; }, [attempt]);
  useEffect(() => {
    const reactivated = active && !wasActive.current;
    wasActive.current = active;
    if (reactivated && enabled) setState(current => ["error", "stalled"].includes(current.status)
      ? { attempt: current.attempt + 1, automaticRetries: 0, status: "loading" } : current);
  }, [active, enabled]);
  useEffect(() => {
    if (!watchdog || !url || !enabled || state.status !== "loading") return;
    const timer = setTimeout(() => {
      setState(current => current.attempt === attempt && current.status === "loading"
        ? { ...current, status: "stalled" } : current);
    }, IMAGE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [attempt, enabled, state.status, url, watchdog]);
  useEffect(() => {
    if (!enabled || !automaticRetry || !["error", "stalled"].includes(state.status) || state.automaticRetries >= 2) return;
    const timer = setTimeout(() => setState(current => current.attempt === attempt && ["error", "stalled"].includes(current.status)
      ? { attempt: current.attempt + 1, automaticRetries: current.automaticRetries + 1, status: "loading" } : current), 600 * (state.automaticRetries + 1));
    return () => clearTimeout(timer);
  }, [attempt, automaticRetry, enabled, state.automaticRetries, state.status]);
  const loaded = useCallback((size: { width: number; height: number }) => {
    if (!mounted.current) return;
    setState(current => current.attempt !== attempt || current.status === "loaded" ? current :
      size.width > 0 && size.height > 0 ? { ...current, status: "loaded", size } : { ...current, status: "error" });
  }, [attempt]);
  const failed = useCallback(() => {
    if (!mounted.current) return;
    setState(current => current.attempt === attempt && current.status !== "error"
      ? { ...current, status: "error" } : current);
  }, [attempt]);
  const started = useCallback(() => {
    if (!mounted.current || display.current.attempt !== attempt) return;
    display.current = { attempt, displayed: false };
    setState(current => current.attempt === attempt ? { ...current, status: "loading", size: undefined } : current);
  }, [attempt]);
  const decoded = useCallback((size: { width: number; height: number }) => {
    if (!mounted.current || display.current.attempt !== attempt) return;
    if (!(size.width > 0 && size.height > 0)) { failed(); return; }
    display.current.size = size;
    if (display.current.displayed) loaded(size);
  }, [attempt, failed, loaded]);
  const displayed = useCallback(() => {
    if (!mounted.current || display.current.attempt !== attempt) return;
    display.current.displayed = true;
    if (display.current.size) loaded(display.current.size);
  }, [attempt, loaded]);
  const stalled = useCallback(() => {
    if (!mounted.current) return;
    setState(current => current.attempt === attempt && current.status === "loading" ? { ...current, status: "stalled" } : current);
  }, [attempt]);
  const retry = () => setState(current => ["error", "stalled"].includes(current.status)
    ? { attempt: current.attempt + 1, automaticRetries: 0, status: "loading" } : current);
  return { ...state, loaded, failed, started, decoded, displayed, stalled, retry };
}

type ProgressiveListingImageProps = {
  source?: string;
  previewSource?: string;
  thumbnailSource?: string;
  loadOriginal?: boolean;
  active?: boolean;
  contentFit?: "contain" | "cover";
  accessibilityLabel: string;
  onLoad?: (size: { width: number; height: number }) => void;
  renderImage?: (layers: ReactNode) => ReactNode;
};

/** Keep the already-cached preview visible while the selected original loads. */
export function ProgressiveListingImage(props: ProgressiveListingImageProps) {
  return <ProgressiveListingImageContent
    key={`${props.source || ""}|${props.previewSource || ""}|${props.thumbnailSource || ""}`}
    {...props}
  />;
}

function ProgressiveListingImageContent({
  source,
  previewSource,
  thumbnailSource,
  loadOriginal = false,
  active = false,
  contentFit = "contain",
  accessibilityLabel,
  onLoad,
  renderImage,
}: ProgressiveListingImageProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const preview = previewSource || thumbnailSource || source;
  const thumbnail = thumbnailSource !== preview ? thumbnailSource : undefined;
  const [originalRequested, setOriginalRequested] = useState(loadOriginal);
  if (loadOriginal && !originalRequested) setOriginalRequested(true);
  // Equal server URLs represent the same delivery image. Use one shared native
  // preview; a distinct legacy source stays mounted after its first activation.
  const original = (loadOriginal || originalRequested) && source !== preview && source !== thumbnail ? source : undefined;
  const previewLayer = useImageLayer(preview, !!preview, { automaticRetry: Platform.OS === "web", active, watchdog: Platform.OS === "web" });
  const thumbnailLayer = useImageLayer(thumbnail, !!thumbnail, { automaticRetry: Platform.OS === "web", active, watchdog: Platform.OS === "web" });
  const originalLayer = useImageLayer(original, !!original, { active: loadOriginal });
  const previewVisible = !!preview && previewLayer.status === "loaded";
  const thumbnailVisible = !!thumbnail && thumbnailLayer.status === "loaded";
  const originalVisible = !!original && originalLayer.status === "loaded";
  const visible = previewVisible || thumbnailVisible || originalVisible;
  const failed = (!preview || ["error", "stalled"].includes(previewLayer.status)) &&
    (!thumbnail || ["error", "stalled"].includes(thumbnailLayer.status)) &&
    (!original || ["error", "stalled"].includes(originalLayer.status));
  const originalFailed = loadOriginal && !!source && (
    original ? ["error", "stalled"].includes(originalLayer.status) :
      source === preview ? ["error", "stalled"].includes(previewLayer.status) : ["error", "stalled"].includes(thumbnailLayer.status)
  );
  const loading = !failed && (!visible || (!!original && originalLayer.status === "loading"));
  const shownSize = originalVisible ? originalLayer.size : previewVisible ? previewLayer.size : thumbnailLayer.size;
  useEffect(() => {
    if (shownSize) onLoad?.(shownSize);
  }, [onLoad, shownSize]);

  const retry = () => {
    previewLayer.retry();
    thumbnailLayer.retry();
    originalLayer.retry();
  };
  const renderPreview = (url: string, layer: ReturnType<typeof useImageLayer>, label: string) => Platform.OS !== "web"
    ? <NativeGalleryPreview key={url} url={url} attempt={layer.attempt} contentFit={contentFit}
        accessibilityLabel={label} priority={active ? 20 : 0} onLoaded={layer.loaded} onError={layer.failed} onStalled={layer.stalled} />
    : <Image key={`${url}-${layer.attempt}`} source={url} accessibilityLabel={label}
        contentFit={contentFit} cachePolicy="memory-disk" transition={0} priority={loadOriginal ? "high" : "normal"}
        onLoadStart={layer.started} onLoad={({ source: loaded }) => layer.decoded(loaded)}
        onDisplay={layer.displayed} onError={layer.failed}
        style={StyleSheet.absoluteFill} />;
  const layers = <>
    {thumbnail
      ? renderPreview(thumbnail, thumbnailLayer, accessibilityLabel) : null}
    {preview ? renderPreview(preview, previewLayer, accessibilityLabel) : null}
    {original ? <Image
      key={`original-${original}-${originalLayer.attempt}`}
      source={original}
      accessibilityLabel={accessibilityLabel}
      contentFit={contentFit}
      cachePolicy="memory-disk"
      priority={loadOriginal ? "high" : "normal"}
      transition={0}
      onLoadStart={originalLayer.started}
      onLoad={({ source: loaded }) => originalLayer.decoded(loaded)}
      onDisplay={originalLayer.displayed}
      onError={originalLayer.failed}
      style={[StyleSheet.absoluteFill, { opacity: originalVisible ? 1 : 0 }]}
    /> : null}
  </>;
  return <>
    {renderImage ? renderImage(layers) : layers}
    {!visible ? <View style={styles.empty} pointerEvents="none">
      {loading ? <ActivityIndicator color={colors.primary} accessibilityLabel="جارٍ تحميل الصورة" /> :
        <Icon name="image-outline" size={38} color={colors.muted} />}
    </View> : null}
    {visible && loading ? <View pointerEvents="none" style={styles.loadingBadge}>
      <ActivityIndicator size="small" color="white" />
      <AppText style={styles.loadingText}>جارٍ تحميل الصورة الواضحة</AppText>
    </View> : null}
    {failed || (originalFailed && visible) ?
      <View style={styles.notice}>
        <InlineNotice
          message={visible ? "تُعرض معاينة الصورة. تعذّر تحميل الصورة الواضحة." : "تعذّر تحميل الصورة. أعد المحاولة."}
          onRetry={retry}
        />
      </View> : null}
  </>;
}

type ZoomableGalleryImageProps = {
  source?: string;
  previewSource?: string;
  thumbnailSource?: string;
  accessibilityLabel: string;
  scrollGesture: NativeGesture;
  width: number;
  height: number;
  active: boolean;
};

const MIN_SCALE = 1;
const MAX_SCALE = 5;

function clamp(value: number, min: number, max: number) {
  "worklet";
  return Math.min(max, Math.max(min, value));
}

export function ZoomableGalleryImage({
  source,
  previewSource,
  thumbnailSource,
  accessibilityLabel,
  scrollGesture,
  width,
  height,
  active,
}: ZoomableGalleryImageProps) {
  const styles = useStyles();
  const scale = useSharedValue(MIN_SCALE);
  const savedScale = useSharedValue(MIN_SCALE);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);
  const panStartX = useSharedValue(0);
  const panStartY = useSharedValue(0);
  const pinchOriginX = useSharedValue(0);
  const pinchOriginY = useSharedValue(0);
  const isZoomed = useSharedValue(false);
  const isPinching = useSharedValue(false);
  const imageWidth = useSharedValue(0);
  const imageHeight = useSharedValue(0);
  const imageReady = useSharedValue(false);

  const resetTransform = useCallback(() => {
    scale.set(MIN_SCALE);
    savedScale.set(MIN_SCALE);
    translateX.set(0);
    translateY.set(0);
    savedTranslateX.set(0);
    savedTranslateY.set(0);
    panStartX.set(0);
    panStartY.set(0);
    pinchOriginX.set(0);
    pinchOriginY.set(0);
    isZoomed.set(false);
    isPinching.set(false);
  }, [
    isPinching, isZoomed, panStartX, panStartY, pinchOriginX, pinchOriginY,
    savedScale, savedTranslateX, savedTranslateY, scale, translateX, translateY,
  ]);

  useLayoutEffect(() => {
    resetTransform();
  }, [active, height, resetTransform, source, width]);
  useLayoutEffect(() => {
    imageReady.set(false);
    imageWidth.set(0);
    imageHeight.set(0);
  }, [imageHeight, imageReady, imageWidth, source]);

  const pinch = usePinchGesture({
    enabled: imageReady,
    block: scrollGesture,
    onActivate: (event) => {
      isPinching.set(true);
      savedScale.set(scale.get());
      savedTranslateX.set(translateX.get());
      savedTranslateY.set(translateY.get());
      const focalX = event.focalX - width / 2;
      const focalY = event.focalY - height / 2;
      pinchOriginX.set((focalX - savedTranslateX.get()) / Math.max(savedScale.get(), MIN_SCALE));
      pinchOriginY.set((focalY - savedTranslateY.get()) / Math.max(savedScale.get(), MIN_SCALE));
    },
    onUpdate: (event) => {
      const nextScale = clamp(savedScale.get() * event.scale, MIN_SCALE, MAX_SCALE);
      const focalX = event.focalX - width / 2;
      const focalY = event.focalY - height / 2;
      scale.set(nextScale);
      const { maxX, maxY } = getGalleryPanBounds(
        width, height, imageWidth.get(), imageHeight.get(), nextScale,
      );
      translateX.set(clamp(
        focalX - pinchOriginX.get() * nextScale,
        -maxX,
        maxX,
      ));
      translateY.set(clamp(
        focalY - pinchOriginY.get() * nextScale,
        -maxY,
        maxY,
      ));
    },
    onDeactivate: () => {
      isPinching.set(false);
      if (scale.get() <= MIN_SCALE + 0.02) {
        scale.set(MIN_SCALE);
        savedScale.set(MIN_SCALE);
        translateX.set(0);
        translateY.set(0);
        savedTranslateX.set(0);
        savedTranslateY.set(0);
        isZoomed.set(false);
        return;
      }
      savedScale.set(scale.get());
      savedTranslateX.set(translateX.get());
      savedTranslateY.set(translateY.get());
      isZoomed.set(true);
    },
  });

  const pan = usePanGesture({
    enabled: isZoomed,
    block: scrollGesture,
    minDistance: 1,
    averageTouches: true,
    onActivate: () => {
      panStartX.set(translateX.get());
      panStartY.set(translateY.get());
    },
    onUpdate: (event) => {
      if (isPinching.get()) return;
      const { maxX, maxY } = getGalleryPanBounds(
        width, height, imageWidth.get(), imageHeight.get(), scale.get(),
      );
      translateX.set(clamp(panStartX.get() + event.translationX, -maxX, maxX));
      translateY.set(clamp(panStartY.get() + event.translationY, -maxY, maxY));
    },
    onDeactivate: () => {
      if (isPinching.get()) return;
      savedTranslateX.set(translateX.get());
      savedTranslateY.set(translateY.get());
    },
  });

  const doubleTap = useTapGesture({
    enabled: imageReady,
    numberOfTaps: 2,
    maxDelay: 280,
    onDeactivate: (event) => {
      if (event.canceled) return;
      if (isZoomed.get()) {
        isZoomed.set(false);
        scale.set(withTiming(MIN_SCALE, { duration: 160 }));
        translateX.set(withTiming(0, { duration: 160 }));
        translateY.set(withTiming(0, { duration: 160 }));
        savedScale.set(MIN_SCALE);
        savedTranslateX.set(0);
        savedTranslateY.set(0);
        return;
      }
      isZoomed.set(true);
      savedScale.set(2.5);
      savedTranslateX.set(0);
      savedTranslateY.set(0);
      scale.set(withTiming(2.5, { duration: 160 }));
      translateX.set(withTiming(0, { duration: 160 }));
      translateY.set(withTiming(0, { duration: 160 }));
    },
  });

  const gesture = useSimultaneousGestures(pan, pinch, doubleTap);
  const positionStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.get() },
      { translateY: translateY.get() },
    ],
  }));
  const zoomStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.get() }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <View
        accessible
        accessibilityLabel={accessibilityLabel}
        style={[styles.page, { width, height }]}
      >
        <ProgressiveListingImage
          key={`${source || ""}|${previewSource || ""}|${thumbnailSource || ""}`}
          source={source}
          previewSource={previewSource}
          thumbnailSource={thumbnailSource}
          loadOriginal={active}
          active={active}
          accessibilityLabel={accessibilityLabel}
          onLoad={(loaded) => {
            imageWidth.set(loaded.width);
            imageHeight.set(loaded.height);
            imageReady.set(loaded.width > 0 && loaded.height > 0);
          }}
          renderImage={(layers) => <Animated.View style={[StyleSheet.absoluteFill, positionStyle]}>
            <Animated.View style={[StyleSheet.absoluteFill, zoomStyle]}>{layers}</Animated.View>
          </Animated.View>}
        />
      </View>
    </GestureDetector>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  page: { width: "100%", height: "100%", overflow: "hidden" },
  empty: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, alignItems: "center", justifyContent: "center" },
  notice: { position: "absolute", bottom: 16, left: 12, right: 12 },
  loadingBadge: { position: "absolute", top: 14, left: 14, flexDirection: "row-reverse", gap: 8, alignItems: "center", borderRadius: 12, padding: 10, backgroundColor: colors.mediaOverlay },
  loadingText: { color: "white", fontSize: 11 },
}));
