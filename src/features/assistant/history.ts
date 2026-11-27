import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import type { UIMessage } from "ai";
import { getApiBaseUrl } from "../../core/api";
import { isCreationChoiceMessage } from "./context";
import { readHamadDraftUi } from "./drafts";

type History = {
  conversationId: string;
  messages: UIMessage[];
  creationMethod: boolean;
};
type Manifest = { chunks: number; updatedAt: number; slot?: 0 | 1 };
const indexKey = "hamad.history.index.v1";
const chunkSize = 500;
const maxChunks = 64;
let epoch = 0;
let operations: Promise<unknown> = Promise.resolve();
const options = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
async function keyFor(ownerId: string) {
  return `hamad.history.${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${getApiBaseUrl()}:${ownerId}`)}`;
}
async function index() {
  try {
    const parsed: unknown = JSON.parse(
      (await SecureStore.getItemAsync(indexKey)) || "[]",
    );
    return Array.isArray(parsed)
      ? parsed.filter(
          (key): key is string =>
            typeof key === "string" &&
            /^hamad\.history\.[a-f0-9]{64}$/.test(key),
        )
      : [];
  } catch {
    return [];
  }
}

async function readManifest(key: string): Promise<Manifest | null> {
  const stored = await SecureStore.getItemAsync(key);
  let value: unknown;
  try { value = JSON.parse(stored || "null"); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const { chunks, updatedAt, slot } = value as Partial<Manifest>;
  if (typeof chunks !== "number" || !Number.isInteger(chunks) || chunks < 1 || chunks > maxChunks
    || typeof updatedAt !== "number" || !Number.isFinite(updatedAt)
    || (slot !== undefined && slot !== 0 && slot !== 1)) return null;
  return { chunks, updatedAt, slot };
}

function chunkKey(key: string, index: number, slot: Manifest["slot"]) {
  return slot === undefined ? `${key}.${index}` : `${key}.slot-${slot}.${index}`;
}

async function deleteChunks(key: string, slot: Manifest["slot"], count: number) {
  await Promise.all(Array.from({ length: count }, (_, index) =>
    SecureStore.deleteItemAsync(chunkKey(key, index, slot)),
  ));
}

async function eraseHistory(key: string) {
  await Promise.all([deleteChunks(key, undefined, maxChunks), deleteChunks(key, 0, maxChunks), deleteChunks(key, 1, maxChunks)]);
  await SecureStore.deleteItemAsync(key);
}
function textOnly(messages: UIMessage[]): UIMessage[] {
  let budget = 20_000;
  let savedDraftMemory = false;
  const safe: UIMessage[] = [];
  for (const message of [...messages].reverse()) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .slice(0, 12_000);
    if (!text || safe.length >= 48 || text.length > budget) continue;
    budget -= text.length;
    const metadata: { creationChoice?: true; hamadDraftMemory?: string; hamadDraftUi?: { active: { title: string; expires: number } } } = {};
    if (isCreationChoiceMessage(message)) metadata.creationChoice = true;
    const memory = (message.metadata as { hamadDraftMemory?: unknown } | undefined)?.hamadDraftMemory;
    if (message.role === "assistant" && !savedDraftMemory && typeof memory === "string"
      && memory.length <= 2_400 && /^[\w-]+\.[\w-]{43}$/.test(memory)) {
      metadata.hamadDraftMemory = memory;
      const { active } = readHamadDraftUi(message.metadata);
      if (active && active.expires > Date.now()) metadata.hamadDraftUi = { active };
      savedDraftMemory = true;
    }
    safe.unshift({
      id: message.id,
      role: message.role,
      parts: [{ type: "text", text }],
      ...(Object.keys(metadata).length ? { metadata } : {}),
    });
  }
  return safe;
}

/** Text only, encrypted by the OS key store, bound to account AND API origin.
 * Photos, tool payloads and base64 attachments are never persisted. */
export async function readAssistantHistory(
  ownerId: string,
): Promise<History | null> {
  const started = epoch;
  const read = operations.catch(() => {}).then(async () => {
    if (started !== epoch) return null;
    const key = await keyFor(ownerId);
    const meta = await readManifest(key);
    if (!meta) return null;
    if (Date.now() - meta.updatedAt > 30 * 86400_000) {
      await eraseHistory(key);
      await SecureStore.setItemAsync(indexKey, JSON.stringify((await index()).filter(item => item !== key)), options);
      return null;
    }
    const chunks = await Promise.all(
      Array.from({ length: meta.chunks }, (_, i) =>
        SecureStore.getItemAsync(chunkKey(key, i, meta.slot)),
      ),
    );
    if (started !== epoch || chunks.some((chunk) => chunk == null)) return null;
    const saved = JSON.parse(chunks.join("")) as History;
    if (
      !/^[A-Za-z0-9_-]{16,80}$/.test(saved.conversationId) ||
      !Array.isArray(saved.messages)
    )
      return null;
    return {
      conversationId: saved.conversationId,
      messages: textOnly(saved.messages),
      creationMethod: saved.creationMethod === true,
    };
  }).catch(() => null);
  operations = read;
  return read;
}

export function writeAssistantHistory(ownerId: string, state: History) {
  const started = epoch;
  const snapshot = {
    conversationId: state.conversationId,
    messages: textOnly(state.messages),
    creationMethod: state.creationMethod,
  };
  const run = async () => {
    if (started !== epoch) return;
    const key = await keyFor(ownerId);
    const value = JSON.stringify(snapshot);
    const chunks = Array.from(
      { length: Math.ceil(value.length / chunkSize) },
      (_, i) => value.slice(i * chunkSize, (i + 1) * chunkSize),
    );
    if (chunks.length > maxChunks) return;
    const keys = await index();
    if (!keys.includes(key))
      await SecureStore.setItemAsync(
        indexKey,
        JSON.stringify([...keys, key]),
        options,
      );
    const previous = await readManifest(key);
    const slot = previous?.slot === 0 ? 1 : 0;
    // The committed manifest continues to address the old snapshot until every
    // chunk in the other slot has been written successfully.
    for (let i = 0; i < chunks.length; i++) {
      if (started !== epoch) return;
      await SecureStore.setItemAsync(chunkKey(key, i, slot), chunks[i], options);
    }
    if (started !== epoch) return;
    await SecureStore.setItemAsync(key, JSON.stringify({ chunks: chunks.length, updatedAt: Date.now(), slot }), options);
    if (previous) await deleteChunks(key, previous.slot, previous.chunks).catch(() => {});
  };
  operations = operations.catch(() => {}).then(run);
  return operations;
}

export async function clearAssistantHistory(ownerId: string) {
  epoch++;
  const clear = async () => {
    const key = await keyFor(ownerId);
    await eraseHistory(key);
    await SecureStore.setItemAsync(
      indexKey,
      JSON.stringify((await index()).filter((item) => item !== key)),
      options,
    );
  };
  // Deletion and writes share one queue. A save begun while deletion awaits
  // the OS key store must not orphan chunks after its manifest/index is cleared.
  operations = operations.catch(() => {}).then(clear);
  await operations;
}

export async function clearAllAssistantHistory() {
  epoch++;
  const clear = async () => {
    for (const key of await index()) {
      await eraseHistory(key);
    }
    await SecureStore.deleteItemAsync(indexKey);
  };
  operations = operations.catch(() => {}).then(clear);
  await operations;
}
