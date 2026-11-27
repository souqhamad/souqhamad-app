import type { Listing } from "./types";

type PublicationFields = {
  title?: string | null;
  category?: string | null;
  description?: string | null;
  city?: string | null;
  price?: Listing["price"] | null;
};

export function listingPublicationFieldsMessage(fields: PublicationFields) {
  const missing = [];
  if ((fields.title?.trim().length ?? 0) < 2) missing.push("عنوان الإعلان");
  if (!fields.category?.trim()) missing.push("التصنيف");
  if ((fields.description?.trim().length ?? 0) < 2) missing.push("الوصف");
  if ((fields.city?.trim().length ?? 0) < 2) missing.push("المدينة");
  const price = fields.price;
  if (price !== "bid" && price !== "negotiable" &&
      !(typeof price === "number" && Number.isFinite(price) && price >= 0))
    missing.push("السعر أو طريقة التسعير");
  return missing.length ? `أكمل الحقول المطلوبة قبل النشر: ${missing.join("، ")}.` : null;
}
