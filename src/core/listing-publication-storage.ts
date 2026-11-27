import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import { z } from "zod";
import { getApiBaseUrl } from "./api";
import type { UploadAsset } from "./types";
import type { PublicationJob } from "./listing-publication";

const uuid = z.string().uuid();
const listing = z.object({
  id: z.string().min(1).max(200), sellerId: z.string().min(1).max(200),
  status: z.enum(["draft", "pending", "published", "paused", "sold", "rejected", "deleted"]),
  category: z.string(), images: z.array(z.object({ id: z.string() }).passthrough()).max(8),
  attributes: z.record(z.string(), z.unknown()),
}).passthrough();
const journalSchema = z.object({
  version: z.literal(1), origin: z.string(), ownerId: z.string(),
  jobs: z.array(z.object({
    id: uuid, ownerId: z.string(), createdAt: z.string(), body: z.record(z.string(), z.unknown()), listing,
    serverId: z.string().optional(), saved: z.boolean(), hadImages: z.boolean(),
    photos: z.array(z.object({ asset: z.object({ uri: z.string(), name: z.string(), type: z.literal("image/jpeg") }),
      sourceUri: z.string().optional(), key: z.string().min(1).max(200), readyId: z.string().optional(),
      resume: z.object({ key: z.string().min(1).max(200), didPut: z.boolean(), mayHaveCommitted: z.boolean().optional(),
        upload: z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
          status: z.enum(["pending", "processing", "ready", "failed", "cancelled", "expired"]),
          expiresAt: z.string(), errorCode: z.string().optional() }),
        metadata: z.object({ fileName: z.string(), mediaType: z.literal("image/jpeg"),
          sizeBytes: z.number().int().positive().max(12 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
      }).optional(),
    })).max(8),
    createKey: z.string(), saveKey: uuid, publishKey: uuid, primaryKey: uuid,
    phase: z.enum(["saving", "images", "publishing", "failed", "complete"]), error: z.string().optional(),
  })).max(20),
});
// Browser previews keep their existing session-scoped blob URLs. Native jobs
// additionally keep private files and a journal for resuming after reopening.
const browserJobs = new Map<string, PublicationJob[]>();
const segment = (value: string) => Array.from(value, char => char.codePointAt(0)!.toString(16)).join("-");
function directory(ownerId: string) {
  const result = new Directory(Paths.document, "listing-publications", segment(getApiBaseUrl()), segment(ownerId));
  result.create({ intermediates: true, idempotent: true });
  return result;
}
function jobDirectory(ownerId: string, jobId: string) {
  uuid.parse(jobId);
  return new Directory(directory(ownerId), jobId);
}

export const publicationStorage = {
  async load(ownerId: string): Promise<PublicationJob[]> {
    const origin = getApiBaseUrl();
    if (Platform.OS === "web") return browserJobs.get(`${origin}:${ownerId}`) ?? [];
    const file = new File(directory(ownerId), "journal.json");
    if (!file.exists) return [];
    if (file.size > 512 * 1024) throw new Error("publication_journal_invalid");
    const value = journalSchema.parse(JSON.parse(await file.text()));
    if (value.ownerId !== ownerId || value.origin !== origin) throw new Error("publication_journal_invalid");
    return value.jobs.filter(job => job.ownerId === ownerId && job.listing.sellerId === ownerId) as PublicationJob[];
  },
  async store(ownerId: string, jobs: PublicationJob[]) {
    const origin = getApiBaseUrl();
    if (Platform.OS === "web") { browserJobs.set(`${origin}:${ownerId}`, jobs); return; }
    const folder = directory(ownerId);
    const temporary = new File(folder, "journal.next.json");
    await temporary.write(JSON.stringify({ version: 1, origin, ownerId, jobs }));
    await temporary.move(new File(folder, "journal.json"), { overwrite: true });
  },
  async keepPhoto(ownerId: string, jobId: string, index: number, asset: UploadAsset): Promise<UploadAsset> {
    if (Platform.OS === "web") return asset;
    const folder = jobDirectory(ownerId, jobId);
    folder.create({ intermediates: true, idempotent: true });
    const target = new File(folder, `${index}.jpg`);
    if (!target.exists) {
      const source = new File(asset.uri);
      if (!source.exists) throw new Error("الصورة غير موجودة على الجهاز. افتح الإعلان وأضفها مجددًا.");
      const temporary = new File(folder, `${index}.next.jpg`);
      await source.copy(temporary, { overwrite: true });
      if (!temporary.size || temporary.size !== source.size || temporary.size > 12 * 1024 * 1024)
        throw new Error("تعذر حفظ الصورة على الجهاز. أعد المحاولة.");
      await temporary.move(target, { overwrite: true });
    }
    return { uri: target.uri, name: asset.name, type: asset.type };
  },
  async releasePhotos(ownerId: string, jobId: string) {
    if (Platform.OS === "web") return;
    const folder = jobDirectory(ownerId, jobId);
    if (folder.exists) await folder.delete();
  },
};
