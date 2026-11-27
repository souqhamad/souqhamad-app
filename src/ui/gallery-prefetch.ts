/** Failed warm-ups remain retryable; concurrent requests for one URL coalesce. */
export function createGalleryPrefetcher(load: (url: string) => Promise<boolean>) {
  const ready = new Set<string>();
  const pending = new Map<string, Promise<boolean>>();
  return async (urls: string[]) => Promise.all(urls.map(url => {
    if (ready.has(url)) return Promise.resolve(true);
    const current = pending.get(url);
    if (current) return current;
    const request = Promise.resolve().then(() => load(url)).then(success => {
      if (success) ready.add(url);
      return success;
    }).catch(() => false).finally(() => pending.delete(url));
    pending.set(url, request);
    return request;
  }));
}
