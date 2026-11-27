import { runImageUploadBatch } from "./image-upload-batch";
import type { ApiIdentity } from "./api";
import type { ListingImageUploadResume } from "./listing-image-upload";
import type { Bootstrap, Listing, UploadAsset } from "./types";

function uncertainPublicationResponse(failure: unknown) {
  if (!failure || typeof failure !== "object" || !("status" in failure)) return false;
  const code = "code" in failure ? failure.code : undefined;
  return typeof failure.status === "number" &&
    ((failure.status >= 500 && failure.status < 600) ||
      (failure.status === 0 && (code === "network" || code === "aborted")));
}

export type PublicationPhase = "saving" | "images" | "publishing" | "failed" | "complete";
export type PublicationPhoto = { asset: UploadAsset; sourceUri?: string; key: string; readyId?: string; resume?: ListingImageUploadResume };
export type PublicationJob = {
  id: string;
  ownerId: string;
  createdAt: string;
  body: Record<string, unknown>;
  listing: Listing;
  serverId?: string;
  saved: boolean;
  photos: PublicationPhoto[];
  createKey: string;
  saveKey: string;
  publishKey: string;
  primaryKey: string;
  hadImages: boolean;
  phase: PublicationPhase;
  error?: string;
};
export type PublicationInput = {
  id: string;
  ownerId: string;
  body: Record<string, unknown>;
  listing: Listing | null;
  assets: UploadAsset[];
  uploadKeys: ReadonlyMap<string, string>;
};
type ImageClient = {
  uploadListingImage: (listingId: string, asset: UploadAsset, options: {
    capability?: Bootstrap["imageUploads"]; idempotencyKey: string;
    onTransferred: () => void;
    onCheckpoint?: (state: ListingImageUploadResume) => Promise<void>;
  }) => Promise<{ listing?: Listing }>;
  getUploadId: (uri: string) => string | undefined;
  getUploadKey?: (uri: string) => string | undefined;
  getResumeState?: (uri: string) => ListingImageUploadResume | undefined;
  restoreListingImage?: (listingId: string, asset: UploadAsset, state: ListingImageUploadResume) => void;
};
type Dependencies = {
  identity: () => ApiIdentity;
  assertIdentity: (identity: ApiIdentity) => void;
  uuid: () => string;
  load: (ownerId: string) => Promise<PublicationJob[]>;
  store: (ownerId: string, jobs: PublicationJob[]) => Promise<void>;
  keepPhoto: (ownerId: string, jobId: string, index: number, asset: UploadAsset) => Promise<UploadAsset>;
  releasePhotos: (ownerId: string, jobId: string) => Promise<void>;
  recoverUploads?: (listingId: string, identity: ApiIdentity) => Promise<void>;
  client: () => ImageClient;
  capability: () => Bootstrap["imageUploads"] | undefined | Promise<Bootstrap["imageUploads"] | undefined>;
  request: (method: "GET" | "POST" | "PATCH", path: string, body: unknown,
    options: { expectedIdentity: ApiIdentity; idempotencyKey?: string }) => Promise<{ listing: Listing }>;
  onListing: (listing: Listing) => void;
  onComplete: (listing: Listing) => void;
  errorText: (error: unknown) => string;
};

/** Owns a submitted operation independently of any screen. Only server results
 * enter the marketplace cache; local progress stays in this account's overlay. */
export class ListingPublicationCoordinator {
  private ownerId: string | null = null;
  private identity?: ApiIdentity;
  private epoch = 0;
  private jobs: PublicationJob[] = [];
  private snapshot: readonly PublicationJob[] = [];
  private listeners = new Set<() => void>();
  private running = new Map<string, Promise<void>>();
  private clients = new Map<string, ImageClient>();
  private writes = Promise.resolve();
  private hydration = Promise.resolve();
  private hydrationFailed = false;
  private reconciled = new Map<string, readonly Listing[]>();

  constructor(private readonly dependencies: Dependencies) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private emit() {
    this.snapshot = this.jobs.map(job => ({ ...job, photos: job.photos.map(photo => ({ ...photo })) }));
    this.listeners.forEach(listener => listener());
  }
  private current(ownerId: string, epoch: number, identity: ApiIdentity) {
    if (this.ownerId !== ownerId || this.epoch !== epoch) throw new Error("publication_account_changed");
    this.dependencies.assertIdentity(identity);
  }
  activate(ownerId: string | null) {
    const identity = this.dependencies.identity();
    if (ownerId === this.ownerId && identity.token === this.identity?.token && identity.generation === this.identity?.generation) return;
    this.ownerId = ownerId;
    this.hydrationFailed = false;
    this.identity = identity;
    const epoch = ++this.epoch;
    this.jobs = [];
    this.clients.clear();
    this.running.clear();
    this.reconciled.clear();
    this.emit();
    if (!ownerId || !identity.token) return;
    this.hydration = this.writes.catch(() => {}).then(() => this.dependencies.load(ownerId)).then(saved => {
      this.current(ownerId, epoch, identity);
      const existing = new Set(this.jobs.map(job => job.id));
      this.jobs.push(...saved.filter(job => job.ownerId === ownerId && !existing.has(job.id)));
      this.emit();
      for (const job of this.jobs) if (job.phase !== "failed" && job.phase !== "complete") void this.run(job);
    }).catch(() => { if (this.epoch === epoch) this.hydrationFailed = true; });
  }
  async enqueue(input: PublicationInput) {
    const identity = this.dependencies.identity();
    const epoch = this.epoch;
    await this.hydration;
    this.current(input.ownerId, epoch, identity);
    if (this.hydrationFailed) throw new Error("تعذر استعادة الإعلانات المنتظرة. أعد فتح التطبيق للمحاولة مجددًا.");
    const existing = this.jobs.find(job => job.id === input.id ||
      (input.listing && job.serverId === input.listing.id && job.phase !== "complete"));
    let baseListing = input.listing;
    if (existing?.phase === "failed" && existing.id !== input.id && existing.serverId === input.listing?.id) {
      // An explicitly edited draft supersedes a settled failed submission, not
      // an in-flight writer. Reconcile ownership/status before replacing it.
      await this.running.get(existing.id);
      this.current(input.ownerId, epoch, identity);
      const fresh = await this.dependencies.request("GET", `/api/marketplace/me/listings/${encodeURIComponent(existing.serverId!)}`,
        undefined, { expectedIdentity: identity });
      this.current(input.ownerId, epoch, identity);
      if (fresh.listing.id !== existing.serverId || fresh.listing.sellerId !== input.ownerId || fresh.listing.status === "deleted")
        throw new Error("الإعلان غير متاح لهذا الحساب.");
      // A second submit can have won while the reconciliation was in flight.
      const replacement = this.jobs.find(job => job !== existing && job.serverId === existing.serverId && job.phase !== "complete");
      if (replacement) return replacement.id;
      baseListing = fresh.listing;
      this.retire(existing);
      void this.dependencies.releasePhotos(existing.ownerId, existing.id).catch(() => {});
    } else if (existing) {
      if (existing.id !== input.id || JSON.stringify(existing.body) !== JSON.stringify(JSON.parse(JSON.stringify(input.body))) ||
        existing.photos.length !== input.assets.length || existing.photos.some((photo, index) =>
          photo.asset.name !== input.assets[index]?.name || (photo.sourceUri ?? photo.asset.uri) !== input.assets[index]?.uri))
        throw new Error("توجد محاولة نشر سابقة لهذا الإعلان. تابعها من إعلاناتي قبل إرسال تعديلات جديدة.");
      if (existing.phase === "failed") this.retry(existing.id);
      return existing.id;
    }
    if (this.jobs.length >= 20) throw new Error("أكمل الإعلانات المنتظرة قبل إضافة إعلان آخر.");
    const body = JSON.parse(JSON.stringify(input.body)) as Record<string, unknown>;
    const listing = {
      ...baseListing, ...body, id: baseListing?.id ?? input.id, sellerId: input.ownerId,
      images: baseListing ? [...baseListing.images] : [], category: String(body.category ?? ""),
      status: baseListing?.status ?? "draft", createdAt: baseListing?.createdAt ?? new Date().toISOString(),
      attributes: body.attributes && typeof body.attributes === "object" && !Array.isArray(body.attributes)
        ? body.attributes as Record<string, unknown> : {},
    } as Listing;
    const job: PublicationJob = {
      id: input.id, ownerId: input.ownerId, createdAt: new Date().toISOString(),
      body, listing, serverId: baseListing?.id, saved: false,
      photos: input.assets.map(asset => ({ asset: { ...asset }, sourceUri: asset.uri, key: input.uploadKeys.get(asset.uri) ?? this.dependencies.uuid() })),
      createKey: input.id, saveKey: this.dependencies.uuid(), publishKey: this.dependencies.uuid(), primaryKey: this.dependencies.uuid(),
      hadImages: Boolean(baseListing?.images.length), phase: "saving",
    };
    this.jobs.unshift(job);
    this.emit();
    void this.run(job);
    return job.id;
  }
  retry(id: string) {
    const job = this.jobs.find(value => value.id === id);
    if (job && job.phase === "failed") {
      const epoch = this.epoch;
      const settling = this.running.get(job.id);
      job.phase = "saving"; job.error = undefined; this.emit();
      if (settling) void settling.then(() => { if (this.epoch === epoch && this.jobs.includes(job)) void this.run(job); });
      else void this.run(job);
    }
  }
  /** Retain the local card until the paginated server list has caught up. */
  reconcile(listings: readonly Listing[]) {
    const finished = this.jobs.filter(job => job.phase === "complete" && listings.some(listing =>
      listing.id === job.serverId && this.atLeastAsRecent(listing, job.listing) &&
      (listing.updatedAt !== job.listing.updatedAt || (listing.status === job.listing.status &&
        job.photos.every(photo => listing.images.some(image => image.id === photo.readyId))))));
    for (const job of finished) this.retire(job);
    // A completed card must not hide a newer deletion or change on another
    // device. Absence from a paginated list alone is not proof of deletion.
    for (const job of this.jobs) {
      if (job.phase !== "complete" || !job.serverId || listings.some(item => item.id === job.serverId) ||
        this.reconciled.get(job.id) === listings) continue;
      this.reconciled.set(job.id, listings);
      const ownerId = job.ownerId, epoch = this.epoch, identity = this.dependencies.identity();
      void this.dependencies.request("GET", `/api/marketplace/me/listings/${encodeURIComponent(job.serverId)}`, undefined,
        { expectedIdentity: identity }).then(result => {
        this.current(ownerId, epoch, identity);
        if (result.listing.id === job.serverId && result.listing.sellerId === ownerId &&
          this.atLeastAsRecent(result.listing, job.listing)) this.retire(job);
      }).catch(error => {
        try {
          this.current(ownerId, epoch, identity);
          if (error && typeof error === "object" && "status" in error && error.status === 404) this.retire(job);
        } catch { /* Account changes never affect the new account's cards. */ }
      });
    }
  }
  private atLeastAsRecent(listing: Listing, previous: Listing) {
    if (!previous.updatedAt) return true;
    return Boolean(listing.updatedAt && Date.parse(listing.updatedAt) >= Date.parse(previous.updatedAt));
  }
  private retire(job: PublicationJob) {
    if (!this.jobs.includes(job)) return;
    this.jobs = this.jobs.filter(item => item !== job);
    this.clients.delete(job.id);
    this.reconciled.delete(job.id);
    this.emit();
    if (this.ownerId && this.identity) void this.checkpoint(this.ownerId, this.epoch, this.identity).catch(() => {});
  }
  private async checkpoint(ownerId: string, epoch: number, identity: ApiIdentity) {
    this.current(ownerId, epoch, identity);
    if (this.hydrationFailed) throw new Error("تعذر استعادة الإعلانات المنتظرة. أعد فتح التطبيق للمحاولة مجددًا.");
    const jobs = JSON.parse(JSON.stringify(this.jobs)) as PublicationJob[];
    const write = this.writes.catch(() => {}).then(() => this.dependencies.store(ownerId, jobs));
    this.writes = write;
    await write;
    this.current(ownerId, epoch, identity);
  }
  private run(job: PublicationJob) {
    const existing = this.running.get(job.id);
    if (existing) return existing;
    const ownerId = job.ownerId, epoch = this.epoch, identity = this.dependencies.identity();
    const current = () => this.current(ownerId, epoch, identity);
    const checkpoint = () => this.checkpoint(ownerId, epoch, identity);
    const accept = (listing: Listing) => {
      current();
      if (listing.sellerId !== ownerId || (job.serverId && listing.id !== job.serverId) || listing.status === "deleted")
        throw new Error("الإعلان غير متاح لهذا الحساب.");
      job.listing = listing; job.serverId = listing.id;
      this.dependencies.onListing(listing); this.emit();
      return listing;
    };
    const request = async (method: "GET" | "POST" | "PATCH", path: string, body?: unknown, key?: string) => {
      current();
      const result = await this.dependencies.request(method, path, body, { expectedIdentity: identity, idempotencyKey: key });
      return accept(result.listing);
    };
    const pending = (async () => {
      await this.hydration;
      current();
      const capability = await this.dependencies.capability();
      current();
      await checkpoint();
      for (let index = 0; index < job.photos.length; index++) {
        const photo = job.photos[index];
        if (photo.readyId) continue;
        photo.asset = await this.dependencies.keepPhoto(ownerId, job.id, index, photo.asset);
        current();
      }
      await checkpoint();
      const resuming = job.saved;
      if (!job.saved) {
        if (job.serverId) {
          await request("PATCH", `/api/marketplace/listings/${encodeURIComponent(job.serverId)}`, job.body, job.saveKey);
        } else {
          const created = await request("POST", "/api/marketplace/listings", job.body, job.createKey);
          // A replay can return a photo draft created before the form was filled.
          if (!created.category && job.body.category) {
            await request("PATCH", `/api/marketplace/listings/${encodeURIComponent(created.id)}`, job.body, job.saveKey);
          }
        }
        job.saved = true;
        await checkpoint();
      } else {
        await request("GET", `/api/marketplace/me/listings/${encodeURIComponent(job.serverId!)}`);
      }
      const path = `/api/marketplace/listings/${encodeURIComponent(job.serverId!)}`;
      // On rollback this existing collection route confirms cancellation of
      // reservations whose initiation response may have been lost before PUT.
      if (resuming && capability?.protocol === "r2-direct-v1" && !capability.enabled) {
        await this.dependencies.recoverUploads?.(job.serverId!, identity);
        current();
      }
      job.phase = "images"; this.emit();
      const client = this.clients.get(job.id) ?? this.dependencies.client();
      this.clients.set(job.id, client);
      await runImageUploadBatch(job.photos.filter(photo => !photo.readyId), async (photo, _index, transferred) => {
        current();
        if (photo.resume) client.restoreListingImage?.(job.serverId!, photo.asset, photo.resume);
        const previous = new Set(job.listing.images.map(image => image.id));
        const rememberKey = () => {
          photo.key = client.getUploadKey?.(photo.asset.uri) ?? photo.key;
          photo.resume = client.getResumeState?.(photo.asset.uri) ?? photo.resume;
        };
        let response: { listing?: Listing };
        try {
          response = await client.uploadListingImage(job.serverId!, photo.asset, {
            capability, idempotencyKey: photo.key,
            onCheckpoint: async state => { current(); photo.key = state.key; photo.resume = state; await checkpoint(); },
            onTransferred: () => {
              current(); rememberKey();
              void checkpoint().catch(() => {});
              transferred();
            },
          });
        } finally { current(); rememberKey(); }
        current();
        if (!response.listing) throw new Error("تعذر التأكد من حفظ الصورة. أعد المحاولة.");
        const result = response.listing;
        const id = client.getUploadId(photo.asset.uri) ?? result.images.find(image => !previous.has(image.id))?.id;
        if (!id || !result.images.some(image => image.id === id)) throw new Error("تعذر التأكد من حفظ الصورة. أعد المحاولة.");
        photo.readyId = id;
        // Another callback may already have accepted a more complete image list.
        if (result.images.length >= job.listing.images.length) accept(result);
        await checkpoint();
      }, capability?.enabled ? 2 : 1);
      let fresh = await request("GET", `/api/marketplace/me/listings/${encodeURIComponent(job.serverId!)}`);
      if (!job.photos.every(photo => fresh.images.some(image => image.id === photo.readyId)))
        throw new Error("تعذر التأكد من حفظ الصور. أعد المحاولة.");
      const primaryId = job.photos[0]?.readyId;
      if (!job.hadImages && primaryId && !fresh.images.some(image => image.id === primaryId && image.isPrimary))
        fresh = await request("PATCH", `${path}/images/${encodeURIComponent(primaryId)}`, { action: "set_primary" }, job.primaryKey);
      job.phase = "publishing"; this.emit(); await checkpoint();
      if (fresh.status !== "published") {
        try {
          // The committed PATCH already returns the authoritative full listing.
          // Another mandatory read can add latency or report failure after success.
          fresh = await request("PATCH", path, { action: "publish" }, job.publishKey);
        } catch (failure) {
          if (!uncertainPublicationResponse(failure)) throw failure;
          current();
          // A lost acknowledgement may have committed. Reconcile by reading;
          // never repeat the publication mutation to discover its outcome.
          const reconciled = await request("GET", `/api/marketplace/me/listings/${encodeURIComponent(job.serverId!)}`);
          if (reconciled.status !== "published") throw failure;
          fresh = reconciled;
        }
      }
      if (!job.photos.every(photo => fresh.images.some(image => image.id === photo.readyId)))
        throw new Error("تعذر التأكد من حفظ الصور. أعد المحاولة.");
      job.phase = "complete"; job.error = undefined; this.emit(); await checkpoint();
      current();
      this.dependencies.onComplete(fresh);
      void this.dependencies.releasePhotos(ownerId, job.id).catch(() => {});
    })().catch(async error => {
      try {
        current();
        job.phase = "failed"; job.error = this.dependencies.errorText(error); this.emit();
        await checkpoint();
      } catch { /* A different account must receive neither state nor callbacks. */ }
    }).finally(() => { if (this.running.get(job.id) === pending) this.running.delete(job.id); });
    this.running.set(job.id, pending);
    return pending;
  }
}
