import { router } from "expo-router";

type ListingLaunch = { expiresAt: number };
let pendingListingLaunch: ListingLaunch | undefined;

// Carry the button's intent to the next screen without changing its shared URL.
export function openAssistant(entry: "listing" | "help") {
  pendingListingLaunch = entry === "listing" ? { expiresAt: Date.now() + 10_000 } : undefined;
  router.push("/create/assistant");
}

export function readListingAssistantLaunch() {
  return pendingListingLaunch && pendingListingLaunch.expiresAt > Date.now()
    ? pendingListingLaunch : undefined;
}

export function clearListingAssistantLaunch(launch: ListingLaunch | undefined) {
  if (pendingListingLaunch === launch) pendingListingLaunch = undefined;
}
