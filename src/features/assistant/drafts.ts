export type HamadDraftAction =
  | { type: "list" }
  | { type: "next"; page: string }
  | { type: "select"; page: string; choice: number };

export type HamadDraftCard = {
  title: string;
  modified: string;
  price: number | "bid" | "negotiable" | undefined;
  imageCount: number;
  thumbnail?: string;
};
export type HamadDraftPreview = HamadDraftCard & { description?: string; city?: string };
export type HamadDraftPage = { key: string; cards: HamadDraftCard[]; hasNext: boolean; refreshed: boolean };
type Active = { title: string; expires: number };

function object(value: unknown) {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function shortText(value: unknown, limit: number) {
  return typeof value === "string" && value.length <= limit && value.trim() ? value : undefined;
}

function card(value: unknown): HamadDraftCard | undefined {
  const source = object(value);
  const title = shortText(source?.title, 120);
  if (!source || !title || typeof source.modified !== "string"
    || !Number.isFinite(Date.parse(source.modified))
    || typeof source.imageCount !== "number" || !Number.isInteger(source.imageCount)
    || source.imageCount < 0) return undefined;
  const { modified, imageCount, price, thumbnail } = source;
  return { title, modified, imageCount,
    price: (typeof price === "number" && Number.isFinite(price) && price >= 0)
      || price === "bid" || price === "negotiable" ? price : undefined,
    thumbnail: typeof thumbnail === "string" && thumbnail.length <= 96_000
      && (/^https:\/\/[^\s]+$/u.test(thumbnail) || /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/u.test(thumbnail))
      ? thumbnail : undefined };
}

export function readHamadDraftUi(metadata: unknown) {
  const source = object(object(metadata)?.hamadDraftUi);
  const focus = object(source?.active);
  const activeTitle = shortText(focus?.title, 120);
  const active: Active | undefined = activeTitle && typeof focus?.expires === "number" && Number.isFinite(focus.expires)
    ? { title: activeTitle, expires: focus.expires } : undefined;
  const list = object(source?.page);
  const entries = Array.isArray(list?.cards) && list.cards.length > 0 && list.cards.length <= 4
    ? list.cards.map(card) : undefined;
  const page = typeof list?.key === "string" && /^[a-f0-9]{64}:[0-9]{1,5}$/u.test(list.key)
    && entries?.every((entry): entry is HamadDraftCard => !!entry)
    ? { key: list.key, cards: entries, hasNext: list.hasNext === true, refreshed: list.refreshed === true } : undefined;
  const previewCard = card(source?.preview);
  const details = object(source?.preview);
  const preview = previewCard && { ...previewCard, description: shortText(details?.description, 1_400),
    city: shortText(details?.city, 80) };
  return { active, page, preview };
}
