import { api, ApiError, assertApiIdentity, getApiIdentity, registerIdentityAbortController } from "./api";
import type { Bootstrap, Listing } from "./types";

export type RecoveredImageUpload = { id: string; status: "pending" | "processing"; expiresAt: string };
export type ImageUploadRecoveryState = { loading: boolean; uploads: RecoveredImageUpload[]; cancelling: string[]; error: unknown };
type Options = {
  listingId: string;
  capability?: Bootstrap["imageUploads"];
  onState: (state: ImageUploadRecoveryState) => void;
  onImages: (listing: Listing) => void;
  localUploadIds?: () => Set<string>;
  imageRevision?: () => number;
};
const failed = () => new ApiError(0, "invalid_response", "تعذّر متابعة الصور. أعد المحاولة.");
export function mergeRecoveredListingImages(current: Listing | null, fresh: Listing) {
  return current?.id === fresh.id ? { ...current, images: fresh.images } : current;
}

/** Recover only the jobs present when this editor opens. New local uploads keep
 * their existing chosen previews and are owned by ListingImageUploadClient. */
export class ListingImageUploadRecovery {
  private readonly identity = getApiIdentity();
  private readonly controller = new AbortController();
  private unregister?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private tracked?: Set<string>;
  private running = false;
  private stopped = false;
  private imagesDirty = true;
  private failures = 0;
  private state: ImageUploadRecoveryState = { loading: false, uploads: [], cancelling: [], error: null };

  constructor(private readonly options: Options) {}

  private path() { return `/api/marketplace/listings/${encodeURIComponent(this.options.listingId)}/image-uploads`; }
  private current() {
    if (this.stopped || this.controller.signal.aborted) return false;
    try { assertApiIdentity(this.identity); return true; } catch { return false; }
  }
  private emit(change: Partial<ImageUploadRecoveryState>) {
    if (!this.current()) return;
    this.state = { ...this.state, ...change };
    this.options.onState(this.state);
  }
  start() {
    if (this.options.capability?.protocol !== "r2-direct-v1" || !this.current()) return;
    this.unregister ??= registerIdentityAbortController(this.controller, this.identity);
    void this.refresh();
  }
  retry() {
    clearTimeout(this.timer);
    // Explicit retry also discovers a reservation whose original initiation
    // committed after the opening snapshot (for example after a lost response).
    this.tracked = undefined;
    this.imagesDirty = true;
    this.failures = 0;
    void this.refresh();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.controller.abort();
    this.unregister?.();
  }
  async cancel(id: string) {
    if (!this.current() || !this.state.uploads.some(upload => upload.id === id) || this.state.cancelling.includes(id)) return;
    this.emit({ cancelling: [...this.state.cancelling, id], error: null });
    try {
      await api.delete(`${this.path()}/${encodeURIComponent(id)}`, undefined, { signal: this.controller.signal, expectedIdentity: this.identity });
      if (!this.current()) return;
      await this.refresh();
    } catch (error) {
      if (this.current()) this.emit({ error });
    } finally {
      if (this.current()) this.emit({ cancelling: this.state.cancelling.filter(value => value !== id) });
    }
  }
  private async refresh() {
    if (this.running || !this.current()) return;
    this.running = true;
    const revision = this.options.imageRevision?.();
    const settings = { signal: this.controller.signal, expectedIdentity: this.identity };
    try {
      this.emit({ loading: true, error: null });
      const result = await api.get<{ uploads: RecoveredImageUpload[] }>(this.path(), undefined, settings);
      if (!this.current()) return;
      if (!Array.isArray(result.uploads) || result.uploads.some(upload => !/^[a-zA-Z0-9_-]{1,128}$/.test(upload.id) ||
        !["pending", "processing"].includes(upload.status) || !Number.isFinite(Date.parse(upload.expiresAt)))) throw failed();
      const localIds = this.options.localUploadIds?.() ?? new Set<string>();
      const initial = this.tracked === undefined;
      this.tracked ??= new Set(result.uploads.filter(upload => !localIds.has(upload.id)).map(upload => upload.id));
      let uploads = result.uploads.filter(upload => this.tracked!.has(upload.id) && !localIds.has(upload.id));
      const previous = new Set(this.state.uploads.map(upload => upload.id));
      const changed = !initial && [...previous].some(id => !uploads.some(upload => upload.id === id));
      if (changed || initial) this.imagesDirty = true;
      if (this.imagesDirty) {
        const fresh = await api.get<{ listing: Listing }>(`/api/marketplace/me/listings/${encodeURIComponent(this.options.listingId)}`, undefined, settings);
        if (!this.current()) return;
        if (!fresh.listing || fresh.listing.id !== this.options.listingId || !Array.isArray(fresh.listing.images)) throw failed();
        // A delete/upload/primary-image action may have committed while this
        // snapshot was in flight. Refresh again instead of restoring old images.
        if (revision !== this.options.imageRevision?.()) {
          this.emit({ loading: false });
          this.timer = setTimeout(() => { void this.refresh(); }, 0);
          return;
        }
        this.options.onImages(fresh.listing);
        this.imagesDirty = false;
        // A job can finish between collection and listing reads. Do not show
        // both a waiting row and its now-ready image during that interval.
        const readyIds = new Set(fresh.listing.images.map(image => image.id));
        uploads = uploads.filter(upload => !readyIds.has(upload.id));
      }
      this.failures = 0;
      this.emit({ uploads, loading: false });
      if (uploads.length) this.timer = setTimeout(() => { void this.refresh(); }, 2000);
    } catch (error) {
      if (this.current()) {
        this.emit({ loading: false, error });
        // A brief disconnect must not require closing the editor to rediscover jobs.
        if (++this.failures <= 5) this.timer = setTimeout(() => { void this.refresh(); }, Math.min(30_000, 2000 * 2 ** (this.failures - 1)));
      }
    } finally { this.running = false; }
  }
}
