type Key = readonly unknown[];
export type QueryEvent = { type: string; payload?: Record<string, unknown> };
const accountFamilies = new Set(["notifications", "conversations", "conversation", "commissions", "favorites", "follows", "similar-follow", "seller-follow", "seller-rating"]);
const id = (value: unknown) => typeof value === "string" && value.length > 0 ? value : undefined;

/** Only data backed by live marketplace events participates in reconciliation. */
export function isRealtimeQuery(key: Key, userId?: string | null) {
  if (["marketplace", "listing", "seller"].includes(String(key[0]))) return true;
  if (!userId || key[1] !== userId) return false;
  if (["owned-listing", "my-listings", "favorite"].includes(String(key[0]))) return true;
  return key[0] === "account" && accountFamilies.has(String(key[2]));
}

export function eventInvalidatesQuery(event: QueryEvent, key: Key, userId?: string | null) {
  if (!isRealtimeQuery(key, userId)) return false;
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const listingId = id(payload.listingId) || (event.type === "moderation_updated" && payload.entity === "listing" ? id(payload.entityId) : undefined);
  const sellerId = id(payload.sellerId);
  const conversationId = id(payload.conversationId);
  const ownAccount = !!userId && key[0] === "account" && key[1] === userId;
  const listingEvent = ["ad_created", "ad_updated", "ad_deleted", "ad_status_changed"].includes(event.type) || (event.type === "moderation_updated" && payload.entity === "listing");
  if (event.type === "maintenance_cleanup") return true;
  if (listingEvent) {
    if (key[0] === "marketplace") return true;
    if (key[0] === "listing") return key[2] === "similar" || (!!listingId && key[1] === listingId);
    if (key[0] === "seller") return !!sellerId && key[1] === sellerId;
    if (key[0] === "owned-listing") return (!sellerId || sellerId === userId) && !!listingId && key[2] === listingId;
    if (key[0] === "my-listings") return !sellerId || sellerId === userId;
    if (key[0] === "favorite") return !!listingId && key[2] === listingId;
    return ownAccount && key[2] === "favorites";
  }
  if (["message_created", "conversation_updated"].includes(event.type)) {
    if (!ownAccount) return false;
    if (key[2] === "conversations") return true;
    return key[2] === "conversation" && !!conversationId && key[3] === conversationId;
  }
  if (event.type === "commission_updated") return ownAccount && key[2] === "commissions";
  if (["listing_notification_created", "follow_listing_published"].includes(event.type))
    return ownAccount && ["notifications", "follows"].includes(String(key[2]));
  return false;
}
