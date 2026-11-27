import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { fetch as streamFetch } from "expo/fetch";
import { useQueryClient } from "@tanstack/react-query";
import { getApiBaseUrl, getSessionToken, getApiIdentity, assertApiIdentity } from "./api";
import { NativeSseDecoder } from "./realtime-decoder";
import { eventInvalidatesQuery, isRealtimeQuery } from "./realtime-query-invalidation";
import { createRealtimeQueryRefresh } from "./realtime-query-refresh";

export type RealtimeEvent = {
  id: number;
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
};
export type RealtimeState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "paused";

/** Native SSE transport. Events invalidate authoritative API reads; payloads are
 * never treated as complete marketplace records or authorization decisions. */
export function useRealtime(
  userId?: string | null,
  onEvent?: (event: RealtimeEvent) => void,
  enabled = true,
) {
  const client = useQueryClient();
  const callback = useRef(onEvent);
  useEffect(() => {
    callback.current = onEvent;
  }, [onEvent]);
  const identityGeneration = getApiIdentity().generation;
  const [state, setState] = useState<RealtimeState>("connecting");
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const identity = { token: getSessionToken(), generation: identityGeneration };
    const current = () => {
      if (disposed) return false;
      try { assertApiIdentity(identity); return true; } catch { return false; }
    };
    let connected = false;
    let active = AppState.currentState === "active";
    const reads = createRealtimeQueryRefresh(client, () => current() && active);
    let controller: AbortController | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let lastId: number | null = null;
    let connecting = false;
    const resync = (periodic = false, afterConnection = false) => {
      if (!current()) return;
      const oldest = Date.now() - (connected ? 90_000 : 30_000);
      void reads.refresh(query => isRealtimeQuery(query.queryKey, userId) &&
        (!periodic || (query.isActive() && query.state.dataUpdatedAt < oldest)), afterConnection);
    };
    const connect = async () => {
      if (!current() || !active || connecting) return;
      connecting = true;
      controller = new AbortController();
      const currentController = controller;
      setState(attempt ? "reconnecting" : "connecting");
      try {
        const token = await getSessionToken();
        if (!current() || !active) return;
        const headers: Record<string, string> = { Accept: "text/event-stream" };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (lastId !== null) headers["Last-Event-ID"] = String(lastId);
        const response = await streamFetch(
          `${getApiBaseUrl()}/api/realtime/stream`,
          { headers, signal: currentController.signal },
        );
        if (!response.ok || !response.body)
          throw new Error(`realtime_${response.status}`);
        if (!current() || !active) { await response.body.cancel().catch(() => {}); return; }
        connected = true;
        setState("connected");
        attempt = 0;
        // The current server has process-local cursors. Always reconcile on
        // reconnect so a restart or a different replica cannot hide updates.
        resync(false, true);
        const reader = response.body.getReader();
        const decoder = new NativeSseDecoder();
        try {
          while (current() && active) {
            const next = await reader.read();
            if (next.done) break;
            if (!current() || !active) break;
            for (const frame of decoder.feed(next.value)) {
              if (frame.event !== "smartstore") continue;
              try {
                const event = JSON.parse(frame.data) as RealtimeEvent;
                if (
                  !Number.isSafeInteger(event.id) ||
                  typeof event.type !== "string"
                )
                  continue;
                lastId = event.id;
                callback.current?.(event);
                void reads.refresh(query => eventInvalidatesQuery(event, query.queryKey, userId));
              } catch {
                /* A malformed event must not terminate the connection. */
              }
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } catch {
        if (current() && active) {
          setState("reconnecting");
          resync();
        }
      } finally {
        connected = false;
        connecting = false;
        if (current() && active) {
          // Spread reconnect attempts across clients after a shared outage.
          const delay =
            Math.min(30_000, 2000 * 2 ** Math.min(attempt++, 4)) +
            Math.random() * 750;
          retry = setTimeout(() => void connect(), delay);
        }
      }
    };
    const subscription = AppState.addEventListener("change", (next) => {
      if (!current()) return;
      active = next === "active";
      if (retry) clearTimeout(retry);
      if (!active) {
        setState("paused");
        controller?.abort();
      } else {
        lastId = null;
        resync();
        void connect();
      }
    });
    void connect();
    // Polling remains a reconciliation safety net, including with a connected
    // process-local SSE server behind a load balancer.
    const fallback = setInterval(() => {
      if (active) resync(true);
    }, 30_000);
    return () => {
      disposed = true;
      reads.dispose();
      controller?.abort();
      if (retry) clearTimeout(retry);
      clearInterval(fallback);
      subscription.remove();
    };
  }, [client, identityGeneration, userId, enabled]);
  return state;
}
