import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "./api";
import type { Bootstrap } from "./types";
import catalog from "./market-catalog.json";

export async function loadBootstrap(signal?: AbortSignal): Promise<Bootstrap> {
  try {
    return await api.get<Bootstrap>("/api/mobile/bootstrap", undefined, { signal });
  } catch (error) {
    if (!__DEV__ || !(error instanceof ApiError) || error.status !== 404)
      throw error;
    // Older local servers can still preview the public catalog. Release builds
    // require server policies, limits and sign-in capabilities to be available.
    const google = await api.get<{ clientId: string }>(
      "/api/auth/google/native-config", undefined, { signal },
    ).catch(() => null);
    return {
      ...catalog,
      configurationSource: "bundled",
      limits: { maxListingImages: 8, maxImageBytes: 12 * 1024 * 1024, maxProfileImageBytes: 4 * 1024 * 1024, maxListingsPerSeller: 100 },
      auth: { google: Boolean(google?.clientId), apple: false },
      policyVersions: {},
      siteMessage: null,
    } as Bootstrap;
  }
}
export function useBootstrap() {
  return useQuery({
    queryKey: ["bootstrap"],
    queryFn: ({ signal }) => loadBootstrap(signal),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}
