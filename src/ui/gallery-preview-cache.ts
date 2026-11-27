export type PreviewResource = { width: number; height: number; release(): void };
export type PreviewSnapshot<T> = Readonly<{
  status: "loading" | "loaded" | "stalled" | "error";
  resource?: T;
}>;
type LoadTask = {
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
};
type Entry<T> = {
  snapshot: PreviewSnapshot<T>;
  listeners: Map<() => void, number>;
  task?: LoadTask;
  failures: number;
  touched: number;
  warmPriority?: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  recoverOnSubscribe: boolean;
};
type CacheOptions = { concurrency: number; retained: number; timeoutMs: number; automaticRetries?: number; retryDelayMs?: number };

/** A listing owns decoded previews; subscriptions outrank background warm-ups.
 * The loader must honor abort during remote I/O. Late decode results are released.
 */
export class GalleryPreviewCache<T extends PreviewResource> {
  private entries = new Map<string, Entry<T>>();
  private running = new Set<LoadTask>();
  private clock = 0;
  private disposed = false;
  private load: (url: string, signal: AbortSignal) => Promise<T>;
  private options: CacheOptions;
  constructor(load: (url: string, signal: AbortSignal) => Promise<T>, options: CacheOptions = { concurrency: 3, retained: 8, timeoutMs: 15000 }) {
    this.load = load;
    this.options = options;
  }

  snapshot(url: string): PreviewSnapshot<T> {
    let entry = this.entries.get(url);
    if (!entry) {
      entry = { snapshot: { status: "loading" }, listeners: new Map(), failures: 0, touched: ++this.clock, recoverOnSubscribe: true };
      this.entries.set(url, entry);
    }
    return entry.snapshot;
  }

  subscribe(url: string, listener: () => void, priority = 0) {
    this.snapshot(url);
    const entry = this.entries.get(url)!;
    const recover = entry.recoverOnSubscribe && !entry.task && !entry.retryTimer && ["error", "stalled"].includes(entry.snapshot.status);
    entry.recoverOnSubscribe = false;
    entry.listeners.set(listener, priority);
    entry.touched = ++this.clock;
    if (recover) this.restart(entry);
    this.pump();
    return () => {
      entry.listeners.delete(listener);
      // React re-subscribes synchronously when a page's priority changes. That
      // is not a new viewing session and must not reset its retry allowance.
      if (!entry.listeners.size) void Promise.resolve().then(() => {
        if (!entry.listeners.size && this.entries.get(url) === entry) entry.recoverOnSubscribe = true;
      });
      this.trim();
      this.pump();
    };
  }

  /** At most eight preview URLs, ordered from selected to furthest. No originals. */
  warm(urls: string[]) {
    if (this.disposed) return;
    for (const entry of this.entries.values()) entry.warmPriority = undefined;
    [...new Set(urls)].slice(0, 8).forEach((url, index) => {
      this.snapshot(url);
      this.entries.get(url)!.warmPriority = -index - 1;
    });
    this.trim();
    this.pump();
  }

  retry(url: string) {
    const entry = this.entries.get(url);
    if (!entry || !["error", "stalled"].includes(entry.snapshot.status) || this.disposed) return;
    this.restart(entry);
    this.pump();
  }

  dispose() {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      clearTimeout(entry.retryTimer);
      if (entry.task) this.finishTask(entry, entry.task, true);
      entry.snapshot.resource?.release();
    }
    this.entries.clear();
  }

  private emit(entry: Entry<T>) { for (const listener of entry.listeners.keys()) listener(); }
  private needed(entry: Entry<T>) { return entry.listeners.size > 0 || entry.warmPriority !== undefined; }
  private priority(entry: Entry<T>) { return Math.max(entry.warmPriority ?? -100, ...entry.listeners.values()); }
  private current(url: string, entry: Entry<T>, task: LoadTask) {
    return !this.disposed && this.entries.get(url) === entry && entry.task === task;
  }
  private finishTask(entry: Entry<T>, task: LoadTask, abort = false) {
    clearTimeout(task.timer);
    this.running.delete(task);
    if (entry.task === task) entry.task = undefined;
    if (abort) task.controller.abort();
  }
  private restart(entry: Entry<T>) {
    clearTimeout(entry.retryTimer);
    entry.retryTimer = undefined;
    if (entry.task) this.finishTask(entry, entry.task, true);
    entry.failures = 0;
    entry.recoverOnSubscribe = false;
    entry.snapshot = { status: "loading" };
    this.emit(entry);
  }
  private failed(url: string, entry: Entry<T>, task: LoadTask, stalled: boolean) {
    if (!this.current(url, entry, task)) return;
    this.finishTask(entry, task, true);
    entry.failures++;
    const retry = entry.failures <= (this.options.automaticRetries ?? 2) && this.needed(entry);
    entry.snapshot = { status: stalled ? "stalled" : retry ? "loading" : "error" };
    if (retry) entry.retryTimer = setTimeout(() => {
      entry.retryTimer = undefined;
      if (this.disposed || this.entries.get(url) !== entry || !this.needed(entry)) return;
      entry.snapshot = { status: "loading" };
      this.emit(entry);
      this.pump();
    }, (this.options.retryDelayMs ?? 600) * entry.failures);
    this.emit(entry);
    this.trim();
    this.pump();
  }

  private pump() {
    if (this.disposed) return;
    const queued = [...this.entries.entries()].sort((a, b) => this.priority(b[1]) - this.priority(a[1]));
    for (const [url, entry] of queued) {
      if (this.running.size >= this.options.concurrency) break;
      if (!this.needed(entry) || entry.snapshot.status !== "loading" || entry.task || entry.retryTimer) continue;
      const task: LoadTask = { controller: new AbortController() };
      entry.task = task;
      this.running.add(task);
      // Queueing is not a network timeout. Start this clock only once this
      // request actually owns a slot, and abort remote I/O at the deadline.
      task.timer = setTimeout(() => this.failed(url, entry, task, true), this.options.timeoutMs);
      void Promise.resolve().then(() => {
        if (task.controller.signal.aborted) throw new Error("Image request aborted");
        return this.load(url, task.controller.signal);
      }).then(resource => {
        if (!this.current(url, entry, task)) { resource.release(); return; }
        if (!(resource.width > 0 && resource.height > 0)) {
          resource.release();
          this.failed(url, entry, task, false);
          return;
        }
        this.finishTask(entry, task);
        entry.snapshot = { status: "loaded", resource };
        entry.failures = 0;
        entry.touched = ++this.clock;
        this.emit(entry);
        this.trim();
        this.pump();
      }).catch(() => this.failed(url, entry, task, false));
    }
  }

  private trim() {
    const unused = [...this.entries.entries()].filter(([, entry]) => !entry.listeners.size)
      .sort((a, b) => (b[1].warmPriority !== undefined ? 1 : 0) - (a[1].warmPriority !== undefined ? 1 : 0) || b[1].touched - a[1].touched);
    for (const [url, entry] of unused.slice(this.options.retained)) {
      clearTimeout(entry.retryTimer);
      if (entry.task) this.finishTask(entry, entry.task, true);
      entry.snapshot.resource?.release();
      this.entries.delete(url);
    }
  }
}