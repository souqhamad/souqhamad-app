export const usageSessionIdleMs = 30 * 60_000;
const heartbeatMs = 5 * 60_000;
const retryMs = 60_000;
export type AppUsageReceipt = { platform: 'ios' | 'android'; visitorId: string; sessionId: string };
type Dependencies = {
  platform: 'ios' | 'android';
  readId: () => Promise<string | null>;
  writeId: (id: string) => Promise<void>;
  uuid: () => string;
  send: (receipt: AppUsageReceipt) => Promise<boolean>;
  now?: () => number;
};

/** One asynchronous producer per app process, independent of accounts and screens. */
export function createAppUsageTracker(deps: Dependencies) {
  const now = deps.now ?? Date.now;
  let active = false, inactiveAt: number | null = null;
  let sessionId = deps.uuid(), visitorId: string | null = null;
  let inFlight = false, lastAttempt = -Infinity, lastDay = '', succeeded = false;
  const day = () => new Date(now() + 3 * 60 * 60_000).toISOString().slice(0, 10);
  async function pulse() {
    if (!active || inFlight) return;
    if (day() === lastDay && now() - lastAttempt < (succeeded ? heartbeatMs : retryMs)) return;
    inFlight = true;
    lastAttempt = now();
    lastDay = day();
    try {
      if (!visitorId) {
        const stored = await deps.readId();
        if (stored && /^[a-zA-Z0-9_-]{16,80}$/.test(stored)) visitorId = stored;
        else {
          const id = deps.uuid();
          // Do not emit an ephemeral identity if durable storage is unavailable.
          await deps.writeId(id);
          visitorId = id;
        }
      }
      if (!active) return;
      succeeded = await deps.send({ platform: deps.platform, visitorId, sessionId });
    } catch { succeeded = false; }
    finally { inFlight = false; }
  }
  return {
    foreground() {
      if (!active && inactiveAt !== null && now() - inactiveAt >= usageSessionIdleMs) {
        sessionId = deps.uuid();
        lastAttempt = -Infinity;
      }
      active = true;
      void pulse();
    },
    background() {
      if (active) inactiveAt = now();
      active = false;
    },
    pulse,
  };
}
