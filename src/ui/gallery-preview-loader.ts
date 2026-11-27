export type DecodedPreview = { width: number; height: number; release(): void };
export type PreviewFile = { uri: string; write(bytes: Uint8Array): void | Promise<void>; delete(): void };
type PreviewResponse = Pick<Response, "ok" | "headers" | "body">;
type PreviewLoaderDependencies<T extends DecodedPreview> = {
  cachedPath(url: string): Promise<string | null>;
  fetch(url: string, options: { signal: AbortSignal; credentials: "omit" }): Promise<PreviewResponse>;
  temporaryFile(): PreviewFile;
  decode(uri: string): Promise<T>;
  persist(uri: string, cacheKey: string): Promise<void>;
};
const MAX_PREVIEW_BYTES = 12 * 1024 * 1024;

function assertActive(signal: AbortSignal) {
  if (signal.aborted) {
    const error = new Error("Image loading was cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

async function readPreview(response: PreviewResponse, signal: AbortSignal) {
  const declaredSize = Number(response.headers.get("content-length"));
  if (!response.ok || declaredSize > MAX_PREVIEW_BYTES || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new Error("Image response is unavailable or too large.");
  }
  const reader = response.body.getReader();
  const aborted = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", aborted, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      assertActive(signal);
      const { done, value } = await reader.read();
      assertActive(signal);
      if (done) break;
      length += value.byteLength;
      if (length > MAX_PREVIEW_BYTES) throw new Error("Image exceeds the preview byte limit.");
      chunks.push(value);
    }
    if (!length) throw new Error("Image response is empty.");
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", aborted);
    reader.releaseLock();
  }
}

/** Network bytes have a cancellable deadline; native decoding only reads a local file.
 * Seed Expo's existing disk cache with the exact CDN URL, without rewriting URLs or
 * giving a native loadAsync request ownership of an uncancellable network transfer.
 */
export function createGalleryPreviewLoader<T extends DecodedPreview>(dependencies: PreviewLoaderDependencies<T>) {
  return async (url: string, signal: AbortSignal): Promise<T> => {
    const decode = async (uri: string) => {
      const resource = await dependencies.decode(uri);
      if (signal.aborted || !(resource.width > 0 && resource.height > 0)) {
        resource.release();
        assertActive(signal);
        throw new Error("Image dimensions are invalid.");
      }
      return resource;
    };
    assertActive(signal);
    // Legacy local/data URLs are decoded directly, with no remote transfer.
    if (!/^https?:\/\//i.test(url)) return decode(url);
    const cached = await dependencies.cachedPath(url).catch(() => null);
    assertActive(signal);
    if (cached) {
      try { return await decode(cached.startsWith("/") ? `file://${cached}` : cached); }
      catch { assertActive(signal); } // Replace an unreadable cached image from the same CDN URL.
    }
    const response = await dependencies.fetch(url, { signal, credentials: "omit" });
    const bytes = await readPreview(response, signal);
    assertActive(signal);
    const file = dependencies.temporaryFile();
    let persistenceOwnsFile = false;
    const remove = () => { try { file.delete(); } catch { /* OS cache eviction can remove it first. */ } };
    try {
      await file.write(bytes);
      assertActive(signal);
      const resource = await decode(file.uri);
      // The decoded ImageRef is ready now; a disk-cache write must not hold up
      // the visible photo. Keep its source file alive until copying has finished.
      persistenceOwnsFile = true;
      void Promise.resolve().then(() => dependencies.persist(file.uri, url))
        .catch(() => {}).finally(remove);
      return resource;
    } finally {
      if (!persistenceOwnsFile) remove();
    }
  };
}
