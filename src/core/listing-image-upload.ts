import { fetch as transferFetch } from "expo/fetch";
import { File } from "expo-file-system";
import * as Crypto from "expo-crypto";
import { Platform } from "react-native";
import { api, ApiError, assertApiIdentity, getApiIdentity, registerIdentityAbortController, type ApiIdentity } from "./api";
import type { Bootstrap, Listing, UploadAsset } from "./types";

type UploadStatus = "pending" | "processing" | "ready" | "failed" | "cancelled" | "expired";
type UploadJob = { id: string; status: UploadStatus; expiresAt: string; errorCode?: string };
type UploadResponse = {
  upload: UploadJob;
  listing?: Listing;
  transfer?: { url: string; method: "PUT"; headers: Record<string, string> };
  sourceUploaded?: boolean;
};
export type ListingImageUploadResume = {
  key: string;
  upload: UploadJob;
  didPut: boolean;
  mayHaveCommitted?: boolean;
  metadata?: { fileName: string; mediaType: "image/jpeg"; sizeBytes: number; sha256: string };
};
export type ImageUploadStage = "preparing" | "uploading" | "processing" | "ready" | "failed";
type Entry = {
  identity: ApiIdentity;
  listingId: string;
  asset: UploadAsset;
  key: string;
  metadata?: { fileName: string; mediaType: "image/jpeg"; sizeBytes: number; sha256: string };
  response?: UploadResponse;
  didPut: boolean;
  mayHaveCommitted: boolean;
  cancelled: boolean;
  legacy?: boolean;
  allowLegacyAfterTerminal?: boolean;
  controller?: AbortController;
  pending?: Promise<{ listing: Listing }>;
  onStage?: (stage: ImageUploadStage) => void;
  onTransferred?: () => void;
  reservation?: { wait: Promise<void>; release: () => void };
  onCheckpoint?: (state: ListingImageUploadResume) => Promise<void>;
};
type UploadOptions = {
  capability?: Bootstrap["imageUploads"];
  idempotencyKey: string;
  signal?: AbortSignal;
  onStage?: (stage: ImageUploadStage) => void;
  onTransferred?: () => void;
  onCheckpoint?: (state: ListingImageUploadResume) => Promise<void>;
};
const MAX_BYTES = 12 * 1024 * 1024;
const ATTEMPT_WAIT_MS = 180000;
const PUT_WAIT_MS = 120000;
const uploadMessage = "تعذّر تجهيز الصورة. أعد المحاولة.";

function error(code: string, message = uploadMessage) {
  return new ApiError(0, code, message);
}
function reportStage(entry: Entry, stage: ImageUploadStage) {
  try { entry.onStage?.(stage); } catch { /* UI observers cannot fail a transfer. */ }
}
function jobPath(entry: Entry) {
  return `/api/marketplace/listings/${encodeURIComponent(entry.listingId)}/image-uploads`;
}
function assertActive(entry: Entry, signal?: AbortSignal) {
  assertApiIdentity(entry.identity);
  if (entry.cancelled || signal?.aborted) throw error("aborted", "توقّف رفع الصورة. أعد المحاولة.");
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(error("aborted"));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(error("aborted"));
    signal.addEventListener("abort", aborted, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}
function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(error("aborted")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, milliseconds);
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  });
}
function readResponse(value: UploadResponse, expectedId?: string): UploadResponse {
  const statuses: UploadStatus[] = ["pending", "processing", "ready", "failed", "cancelled", "expired"];
  if (!value?.upload || typeof value.upload.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.upload.id) ||
    (expectedId !== undefined && value.upload.id !== expectedId) ||
    !statuses.includes(value.upload.status) || !Number.isFinite(Date.parse(value.upload.expiresAt)) ||
    (value.sourceUploaded !== undefined && typeof value.sourceUploaded !== "boolean"))
    throw error("invalid_response");
  return value;
}
function readyListing(entry: Entry, value: UploadResponse) {
  if (value.upload.status !== "ready") return undefined;
  if (!value.listing || value.listing.id !== entry.listingId || !Array.isArray(value.listing.images))
    throw error("invalid_response");
  return { listing: value.listing };
}
function transferSettings(value: UploadResponse, sizeBytes: number) {
  const transfer = value.transfer;
  if (!transfer || transfer.method !== "PUT") throw error("invalid_image_transfer");
  const url = new URL(transfer.url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port ||
    !/^[a-z0-9.-]+\.r2\.cloudflarestorage\.com$/i.test(url.hostname))
    throw error("invalid_image_transfer");
  const headers = new Headers(transfer.headers);
  for (const header of ["authorization", "cookie", "proxy-authorization", "x-souq-hamad-commission-agreement"])
    if (headers.has(header)) throw error("invalid_image_transfer");
  if (headers.get("content-type")?.toLowerCase() !== "image/jpeg" || headers.get("if-none-match") !== "*")
    throw error("invalid_image_transfer");
  const signedLength = headers.get("content-length");
  if (signedLength !== null && (!/^[1-9]\d*$/.test(signedLength) || Number(signedLength) !== sizeBytes))
    throw error("invalid_image_transfer");
  return { url: url.toString(), headers };
}

/** Screen-scoped resumable uploads. Only final server records leave this helper. */
export class ListingImageUploadClient {
  private entries = new Map<string, Entry>();
  private identity = getApiIdentity();
  private initiationTail = Promise.resolve();

  uploadListingImage(listingId: string, asset: UploadAsset, options: UploadOptions): Promise<{ listing?: Listing }> {
    const identity = this.identity;
    try { assertApiIdentity(identity); } catch (failure) { return Promise.reject(failure); }
    const mapKey = `${listingId}:${asset.uri}`;
    let entry = this.entries.get(mapKey);
    if (entry && (entry.identity.token !== identity.token || entry.identity.generation !== identity.generation)) {
      this.cancelEntry(entry);
      this.entries.delete(mapKey);
      entry = undefined;
    }
    if (!entry && (options.capability?.protocol !== "r2-direct-v1" || options.capability.enabled !== true)) {
      options.onStage?.("uploading");
      return api.upload<{ listing?: Listing }>(`/api/marketplace/listings/${encodeURIComponent(listingId)}/images`, asset,
        { idempotencyKey: options.idempotencyKey, expectedIdentity: identity, signal: options.signal })
        .then(result => { assertApiIdentity(identity); options.onStage?.("ready"); return result; });
    }
    if (!identity.token) return Promise.reject(new ApiError(401, "auth_required", "سجّل دخولك لإضافة الصور."));
    if (!entry) {
      entry = { identity, listingId, asset, key: options.idempotencyKey, didPut: false, mayHaveCommitted: false, cancelled: false };
      const wait = this.initiationTail;
      let release!: () => void;
      const turn = new Promise<void>(resolve => { release = resolve; });
      this.initiationTail = wait.then(() => turn);
      entry.reservation = { wait, release };
      this.entries.set(mapKey, entry);
    }
    entry.onStage = options.onStage;
    entry.onTransferred = options.onTransferred;
    entry.onCheckpoint = options.onCheckpoint;
    entry.allowLegacyAfterTerminal = options.capability?.protocol === "r2-direct-v1" && options.capability.enabled === false;
    if (entry.pending) return entry.pending;
    const current = entry;
    const request = this.run(current, options.signal).then(result => {
      reportStage(current, "ready"); return result;
    }).catch(failure => {
      if (!current.cancelled && !options.signal?.aborted) {
        try { assertApiIdentity(current.identity); reportStage(current, "failed"); }
        catch { /* A different account must not receive this upload's state. */ }
      }
      throw failure;
    }).finally(() => { current.pending = undefined; });
    current.pending = request;
    return request;
  }

  cancelAsset(uri: string) {
    for (const [key, entry] of this.entries) if (entry.asset.uri === uri) {
      this.cancelEntry(entry);
      this.entries.delete(key);
    }
  }

  cancelAll() {
    for (const entry of this.entries.values()) this.cancelEntry(entry);
    this.entries.clear();
  }

  getUploadId(uri: string) {
    return [...this.entries.values()].find(entry => entry.asset.uri === uri)?.response?.upload.id;
  }

  getUploadKey(uri: string) {
    return [...this.entries.values()].find(entry => entry.asset.uri === uri)?.key;
  }

  getResumeState(uri: string): ListingImageUploadResume | undefined {
    const entry = [...this.entries.values()].find(value => value.asset.uri === uri);
    return entry?.response ? { key: entry.key, upload: { ...entry.response.upload }, didPut: entry.didPut,
      mayHaveCommitted: entry.mayHaveCommitted,
      ...(entry.metadata ? { metadata: { ...entry.metadata } } : {}) } : undefined;
  }

  restoreListingImage(listingId: string, asset: UploadAsset, state: ListingImageUploadResume) {
    assertApiIdentity(this.identity);
    const mapKey = `${listingId}:${asset.uri}`;
    if (this.entries.has(mapKey)) return;
    if (!state.key || state.key.length > 200) throw error("invalid_response");
    const response = readResponse({ upload: state.upload }, state.upload.id);
    this.entries.set(mapKey, { identity: this.identity, listingId, asset, key: state.key,
      didPut: state.didPut, mayHaveCommitted: state.mayHaveCommitted ?? false, metadata: state.metadata, response, cancelled: false });
  }

  getActiveUploadIds() {
    return new Set([...this.entries.values()].flatMap(entry =>
      !entry.cancelled && entry.pending && entry.response && ["pending", "processing"].includes(entry.response.upload.status)
        ? [entry.response.upload.id] : []));
  }

  private cancelEntry(entry: Entry) {
    entry.cancelled = true;
    entry.controller?.abort();
    entry.reservation?.release();
    if (!entry.response || ["ready", "failed", "expired", "cancelled"].includes(entry.response.upload.status)) return;
    try { assertApiIdentity(entry.identity); } catch { return; }
    void api.delete(`${jobPath(entry)}/${encodeURIComponent(entry.response.upload.id)}`, undefined,
      { expectedIdentity: entry.identity, timeoutMs: 3000 }).catch(() => {});
  }

  private async prepare(entry: Entry, signal: AbortSignal) {
    assertActive(entry, signal);
    reportStage(entry, "preparing");
    if (entry.asset.type !== "image/jpeg") throw error("unsupported_image_type", "اختر صورة بصيغة JPEG.");
    let bytes: ArrayBuffer;
    if (Platform.OS === "web") {
      if (!/^(blob:|data:image\/|file:)/i.test(entry.asset.uri)) throw error("invalid_image_source");
      const selected = await abortable(transferFetch(entry.asset.uri, { signal, credentials: "omit", redirect: "error" }), signal);
      bytes = await abortable(selected.arrayBuffer(), signal);
    } else {
      if (!/^(file|content):/i.test(entry.asset.uri)) throw error("invalid_image_source");
      const file = new File(entry.asset.uri);
      if (file.size > MAX_BYTES) throw error("image_too_large", "حجم الصورة يتجاوز 12 ميجابايت.");
      bytes = await abortable(file.arrayBuffer(), signal);
    }
    assertActive(entry, signal);
    if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) throw error("image_too_large", "حجم الصورة غير مناسب. اختر صورة حتى 12 ميجابايت.");
    const digest = await abortable(Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes), signal);
    assertActive(entry, signal);
    const sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
    if (entry.metadata && (entry.metadata.sha256 !== sha256 || entry.metadata.sizeBytes !== bytes.byteLength))
      throw error("image_changed", "تغيّرت الصورة المختارة. اخترها من جديد.");
    entry.metadata = { fileName: entry.asset.name, mediaType: "image/jpeg", sizeBytes: bytes.byteLength, sha256 };
    return bytes;
  }

  private async legacyAfterTerminal(entry: Entry, signal: AbortSignal) {
    entry.legacy = true;
    const result = await api.upload<{ listing?: Listing }>(`/api/marketplace/listings/${encodeURIComponent(entry.listingId)}/images`, entry.asset,
      { idempotencyKey: entry.key, expectedIdentity: entry.identity, signal });
    assertActive(entry, signal);
    if (!result.listing || result.listing.id !== entry.listingId || !Array.isArray(result.listing.images)) throw error("invalid_response");
    return { listing: result.listing };
  }

  private async run(entry: Entry, externalSignal?: AbortSignal): Promise<{ listing: Listing }> {
    assertActive(entry, externalSignal);
    const startedAt = Date.now();
    const timings = { prepareMs: 0, transferMs: 0, processingMs: 0 };
    let processingStartedAt: number | undefined;
    const measure = async <T>(stage: keyof typeof timings, operation: () => Promise<T>): Promise<T> => {
      const start = Date.now();
      try { return await operation(); }
      finally { timings[stage] += Math.max(0, Date.now() - start); }
    };
    const controller = new AbortController();
    entry.controller = controller;
    const unregister = registerIdentityAbortController(controller, entry.identity);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, ATTEMPT_WAIT_MS);
    const cancelled = () => controller.abort();
    externalSignal?.addEventListener("abort", cancelled, { once: true });
    const signal = controller.signal;
    const settings = { signal, expectedIdentity: entry.identity };
    const waitForRateLimit = async (failure: unknown, attempt: number) => {
      if (!(failure instanceof ApiError) || failure.status !== 429 || failure.retryAfterMs === undefined || attempt >= 2) return false;
      const waitMs = Math.max(1000, failure.retryAfterMs);
      // Respect the server's window without extending this upload's deadline.
      if (Date.now() + waitMs >= startedAt + ATTEMPT_WAIT_MS) return false;
      await delay(waitMs, signal);
      assertActive(entry, signal);
      return true;
    };
    const reserve = async (uploadId?: string) => {
      for (let attempt = 0; ; attempt++) {
        assertActive(entry, signal);
        try {
          return readResponse(await api.post<UploadResponse>(jobPath(entry), entry.metadata,
            { ...settings, idempotencyKey: entry.key }), uploadId);
        } catch (failure) {
          assertActive(entry, signal);
          if (!await waitForRateLimit(failure, attempt)) throw failure;
        }
      }
    };
    const readStatus = async (uploadId: string, reconcileSource = false) => {
      for (let attempt = 0; ; attempt++) {
        assertActive(entry, signal);
        try {
          return readResponse(await api.get<UploadResponse>(`${jobPath(entry)}/${encodeURIComponent(uploadId)}${reconcileSource ? "?reconcile=1" : ""}`, undefined, settings), uploadId);
        } catch (failure) {
          assertActive(entry, signal);
          if (await waitForRateLimit(failure, attempt)) continue;
          const temporary = failure instanceof ApiError &&
            ((failure.status >= 500 && failure.status < 600) ||
              (failure.status === 0 && (failure.code === "network" || failure.code === "aborted")));
          if (!temporary || attempt >= 2) throw failure;
          // Retry only reads inside the existing overall attempt deadline.
          // Transfers and reservation writes retain their existing replay rules.
          await delay(attempt === 0 ? 250 : 750, signal);
        }
      }
    };
    let transferred = false;
    const transferComplete = () => {
      if (transferred) return;
      transferred = true;
      try { entry.onTransferred?.(); } catch { /* UI observers cannot fail a transfer. */ }
    };
    try {
      assertActive(entry, externalSignal);
      if (entry.legacy) return await this.legacyAfterTerminal(entry, signal);
      let bytes: ArrayBuffer | undefined;
      if (entry.response) {
        const previous = entry.response.upload.status;
        if (previous === "failed" || previous === "cancelled" || previous === "expired") {
          entry.response = undefined;
          entry.didPut = false;
          entry.mayHaveCommitted = false;
          entry.key = Crypto.randomUUID();
          if (entry.allowLegacyAfterTerminal && previous !== "failed") return await this.legacyAfterTerminal(entry, signal);
        } else {
          const response = await readStatus(entry.response.upload.id, entry.mayHaveCommitted && !entry.didPut);
          assertActive(entry, signal);
          entry.response = { ...response, transfer: entry.response.transfer };
          if (response.sourceUploaded === true || response.upload.status === "processing") {
            entry.didPut = true; entry.mayHaveCommitted = false;
          }
          // A server without reconciliation support retains conditional PUT
          // compatibility; the create-once grant still prevents overwrites.
          const ready = readyListing(entry, response);
          if (ready) { transferComplete(); return ready; }
          if (response.upload.status === "expired" || response.upload.status === "cancelled") {
            entry.response = undefined; entry.didPut = false; entry.mayHaveCommitted = false; entry.key = Crypto.randomUUID();
            // Rollback is allowed only after the server confirms this direct
            // reservation ended. A network error never switches protocols.
            if (entry.allowLegacyAfterTerminal) return await this.legacyAfterTerminal(entry, signal);
          } else if (response.upload.status === "pending" && !entry.didPut) {
            // A retry can outlive the short-lived presigned URL. Replaying the
            // same initiation key renews its transfer without creating a job.
            entry.response = await reserve(entry.response.upload.id);
            assertActive(entry, signal);
          }
        }
      }
      if (!entry.response) {
        bytes = await measure("prepareMs", () => this.prepare(entry, signal));
        // Reserve in selection order while byte preparation and transfers overlap.
        if (entry.reservation) await abortable(entry.reservation.wait, signal);
        try {
          const response = await reserve();
          assertActive(entry, signal);
          entry.response = response;
        } finally { entry.reservation?.release(); entry.reservation = undefined; }
      }
      let response = entry.response;
      // A publication journal can retain the reservation before any bytes are
      // transferred, without persisting its signed URL or account credentials.
      const reserved = this.getResumeState(entry.asset.uri);
      if (reserved) await entry.onCheckpoint?.(reserved);
      assertActive(entry, signal);
      // Replaying an initiation key can find a job already completed while its
      // earlier response was lost. Initiation returns job metadata; only the
      // owned status endpoint supplies the current authoritative listing.
      if (response.upload.status === "ready" && !response.listing) {
        response = await readStatus(response.upload.id);
        assertActive(entry, signal);
        entry.response = response;
      }
      const initialReady = readyListing(entry, response);
      if (initialReady) { transferComplete(); return initialReady; }
      if (response.upload.status === "pending" && !entry.didPut) {
        bytes ??= await measure("prepareMs", () => this.prepare(entry, signal));
        const transfer = transferSettings(response, bytes.byteLength);
        assertActive(entry, signal);
        reportStage(entry, "uploading");
        entry.mayHaveCommitted = true;
        const committing = this.getResumeState(entry.asset.uri);
        if (committing) await entry.onCheckpoint?.(committing);
        assertActive(entry, signal);
        const uploadOnce = async () => {
          // A stalled PUT must not abort the owned status request that can
          // confirm R2 already accepted it. Account/screen cancellation still
          // cancels both the transfer and the entire operation.
          const transferController = new AbortController();
          const stopTransfer = () => transferController.abort();
          signal.addEventListener("abort", stopTransfer, { once: true });
          const putTimer = setTimeout(stopTransfer, PUT_WAIT_MS);
          try {
            assertActive(entry, signal);
            return await measure("transferMs", () => abortable(transferFetch(transfer.url, {
              method: "PUT", body: bytes, headers: transfer.headers,
              credentials: "omit", redirect: "error", signal: transferController.signal,
            }), transferController.signal));
          } finally {
            clearTimeout(putTimer);
            signal.removeEventListener("abort", stopTransfer);
          }
        };
        for (let attempt = 0; ; attempt++) {
          try {
            const uploaded = await uploadOnce();
            assertActive(entry, signal);
            if ((!uploaded.ok && uploaded.status !== 412) || uploaded.redirected || (uploaded.url && new URL(uploaded.url).origin !== new URL(transfer.url).origin))
              throw error("image_transfer_failed", "تعذّر رفع الصورة. أعد المحاولة.");
            entry.didPut = true;
            entry.mayHaveCommitted = false;
            break;
          } catch (failure) {
            assertActive(entry, signal);
            // Rejected/redirected responses are not ambiguous network commits.
            if (failure instanceof ApiError && failure.code === "image_transfer_failed") throw failure;
            if (attempt >= 1) throw failure;
            const reconciled = await readStatus(response.upload.id, true);
            assertActive(entry, signal);
            entry.response = { ...reconciled, transfer: entry.response?.transfer };
            if (reconciled.sourceUploaded === true || ["processing", "ready"].includes(reconciled.upload.status)) {
              entry.didPut = true; entry.mayHaveCommitted = false;
              response = entry.response;
              break;
            }
            // Retry just this image once, only after R2 confirms it is absent.
            if (reconciled.upload.status !== "pending" || reconciled.sourceUploaded !== false) throw failure;
            await delay(300, signal);
          }
        }
      }
      bytes = undefined;
      const transferredState = this.getResumeState(entry.asset.uri);
      if (transferredState) await entry.onCheckpoint?.(transferredState);
      assertActive(entry, signal);
      // A confirmed PUT or server processing state releases only the transfer
      // slot; the upload promise still waits for the accepted image record.
      if (entry.didPut || response.upload.status === "processing") transferComplete();
      reportStage(entry, "processing");
      processingStartedAt = Date.now();
      let interval = 1000;
      for (;;) {
        assertActive(entry, signal);
        if (response.upload.status === "failed") throw error(response.upload.errorCode || "image_processing_failed");
        if (response.upload.status === "cancelled" || response.upload.status === "expired") throw error(`image_upload_${response.upload.status}`);
        const ready = readyListing(entry, response);
        if (ready) return ready;
        await delay(interval, signal);
        interval = Math.min(2000, interval + 250);
        response = await readStatus(response.upload.id);
        assertActive(entry, signal);
        entry.response = { ...response, transfer: entry.response?.transfer };
      }
    } catch (failure) {
      assertApiIdentity(entry.identity);
      if (timedOut) throw error("image_processing_timeout", "الصورة قيد التجهيز. أعد المحاولة لمتابعتها.");
      if (signal.aborted || externalSignal?.aborted || entry.cancelled) throw error("aborted", "توقّف رفع الصورة. أعد المحاولة.");
      if (failure instanceof ApiError) throw failure;
      throw error("network", "تعذّر الاتصال لرفع الصورة. أعد المحاولة.");
    } finally {
      if (processingStartedAt !== undefined) timings.processingMs = Math.max(0, Date.now() - processingStartedAt);
      try { console.info("[image_upload_timing]", JSON.stringify({ ...timings, totalMs: Math.max(0, Date.now() - startedAt) })); }
      catch { /* Diagnostics cannot affect upload state. */ }
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", cancelled);
      unregister();
      entry.reservation?.release();
      entry.reservation = undefined;
      if (entry.controller === controller) entry.controller = undefined;
    }
  }
}
