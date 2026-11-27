import { createContext, useContext, useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import { api, assertApiIdentity, getApiIdentity, getSessionToken } from "./api";
import { useAuth } from "./auth";
import { loadBootstrap } from "./bootstrap";
import { userMessage } from "./errors";
import { syncListingImageCaches } from "./listing-image-cache";
import { ListingImageUploadClient } from "./listing-image-upload";
import { ListingPublicationCoordinator } from "./listing-publication";
import { publicationStorage } from "./listing-publication-storage";
import { feedbackStore } from "../ui/feedback-store";

const Context = createContext<ListingPublicationCoordinator | null>(null);

export function ListingPublicationProvider({ children }: { children: ReactNode }) {
  const { user, status } = useAuth();
  const client = useQueryClient();
  const [coordinator] = useState(() => new ListingPublicationCoordinator({
    identity: getApiIdentity, assertIdentity: assertApiIdentity, uuid: Crypto.randomUUID,
    ...publicationStorage,
    recoverUploads: async (listingId, expectedIdentity) => {
      await api.get(`/api/marketplace/listings/${encodeURIComponent(listingId)}/image-uploads`, undefined, { expectedIdentity });
    },
    client: () => new ListingImageUploadClient(),
    capability: async () => (await client.fetchQuery({ queryKey: ["bootstrap"], queryFn: ({ signal }) => loadBootstrap(signal), staleTime: 5 * 60_000 })).imageUploads,
    request: (method, path, body, options) => method === "GET"
      ? api.get(path, undefined, options) : method === "POST" ? api.post(path, body, options) : api.patch(path, body, options),
    onListing: listing => syncListingImageCaches(client, listing, { refetch: false }),
    onComplete: listing => {
      syncListingImageCaches(client, listing);
      feedbackStore.enqueue(listing.status === "published" ? "success" : "info", listing.status === "published"
        ? "تم نشر إعلانك" : listing.status === "pending" ? "إعلانك قيد المراجعة" : "راجع حالة الإعلان في إعلاناتي");
    },
    errorText: error => userMessage(error, "تعذر إكمال نشر الإعلان. أعد المحاولة."),
  }));
  const token = getSessionToken();
  useLayoutEffect(() => {
    coordinator.activate(status === "authenticated" ? user?.id ?? null : null);
  }, [coordinator, status, user?.id, token]);
  useEffect(() => () => coordinator.activate(null), [coordinator]);
  return <Context.Provider value={coordinator}>{children}</Context.Provider>;
}

export function useListingPublication() {
  const coordinator = useContext(Context);
  if (!coordinator) throw new Error("ListingPublicationProvider is required");
  const jobs = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, coordinator.getSnapshot);
  return { coordinator, jobs };
}
