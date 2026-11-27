import type { UIMessage } from "ai";

// Older saved histories retained only text, including this server-issued prompt.
const legacyCreationChoice = "كيف تفضّل إنشاء إعلانك؟ اختر الإنشاء مع حمد لتجهيز مسودة بالمحادثة، أو الإنشاء اليدوي لإدخال البيانات بنفسك.";
function normalizeChoiceText(text: string) {
  return text.replace(/[\u064B-\u065F\u0670\u0640\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ").trim();
}

export function isCreationChoiceMessage(message: UIMessage) {
  return message.role === "assistant"
    && ((message.metadata as { creationChoice?: boolean } | undefined)?.creationChoice === true
      || normalizeChoiceText(message.parts.filter(part => part.type === "text").map(part => part.text).join("\n"))
        === normalizeChoiceText(legacyCreationChoice));
}

export function selectAssistantContext(messages: UIMessage[]) {
  const result: UIMessage[] = [];
  let count = 0;
  const latest = messages.findLast((message) => message.role === "user");
  for (const message of [...messages].reverse()) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const parts: UIMessage["parts"] = message.parts.filter(
      (part) =>
        part.type === "text" ||
        (message.id === latest?.id && part.type === "file"),
    );
    if (
      message.id !== latest?.id &&
      message.parts.some((part) => part.type === "file")
    )
      parts.push({
        type: "text",
        text: `Earlier image attachment reference: ${message.id}`,
      });
    const size = parts.reduce(
      (sum, part) => sum + (part.type === "text" ? part.text.length : 0),
      0,
    );
    if (result.length >= 40 || (result.length && count + size > 24_000)) break;
    count += size;
    const metadata = message.metadata as { hamadDraftMemory?: string; creationChoice?: boolean } | undefined;
    result.unshift({ id: message.id, role: message.role, parts,
      ...(metadata && { metadata: { hamadDraftMemory: metadata.hamadDraftMemory, creationChoice: metadata.creationChoice } }) });
  }
  while (result.length && result[0].role !== "user") result.shift();
  return result;
}
