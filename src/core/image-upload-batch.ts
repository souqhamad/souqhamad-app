/** Bound transfers separately from server processing; settle every started job. */
export function runImageUploadBatch<T>(
  items: readonly T[],
  upload: (item: T, index: number, transferred: () => void) => Promise<void>,
  concurrency = 2,
): Promise<void> {
  const limit = Math.max(1, Math.min(2, Math.floor(concurrency) || 1));
  return new Promise<void>((resolve, reject) => {
    let next = 0, transfers = 0, running = 0;
    let failed = false;
    let failure: unknown;
    const finish = () => {
      if (!running && (failed || next === items.length)) {
        if (failed) reject(failure); else resolve();
      }
    };
    const pump = () => {
      while (!failed && transfers < limit && next < items.length) {
        const index = next++;
        transfers++; running++;
        let held = true;
        const transferred = () => {
          if (!held) return;
          held = false; transfers--;
          pump();
        };
        void Promise.resolve().then(() => upload(items[index], index, transferred))
          .catch(error => { if (!failed) { failed = true; failure = error; } })
          .finally(() => { running--; transferred(); finish(); });
      }
      finish();
    };
    pump();
  });
}
