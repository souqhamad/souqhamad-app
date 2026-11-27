import type { Query, QueryClient } from "@tanstack/react-query";

type PendingRead = { dirty: boolean; promise: Promise<void> };

/** Reconcile authoritative reads without cancelling/restarting a page sequence.
 * An event arriving during a read needs one subsequent snapshot, not one retry
 * per frame. Inactive queries stay invalidated until a visible observer returns.
 */
export function createRealtimeQueryRefresh(client: QueryClient, isCurrent: () => boolean) {
  const pending = new Map<Query, PendingRead>();
  let disposed = false;
  const current = () => !disposed && isCurrent();
  const present = (query: Query) => client.getQueryCache().get(query.queryHash) === query;
  const mark = (query: Query) => client.invalidateQueries({
    predicate: candidate => candidate === query,
    refetchType: "none",
  });

  const drain = async (query: Query, entry: PendingRead) => {
    try {
      do {
        entry.dirty = query.state.fetchStatus !== "idle";
        await client.refetchQueries({ predicate: candidate => candidate === query, type: "active" }, { cancelRefetch: false });
        if (!current() || !present(query)) return;
        if (entry.dirty) await mark(query);
        if (query.state.fetchStatus === "paused") return;
      } while (entry.dirty && query.isActive() && !query.isDisabled());
    } finally {
      if (pending.get(query) === entry) pending.delete(query);
    }
  };

  return {
    refresh(predicate: (query: Query) => boolean, requireNewSnapshot = true): Promise<void> {
      if (!current()) return Promise.resolve();
      const work: Promise<void>[] = [];
      for (const query of client.getQueryCache().findAll({ predicate })) {
        void mark(query);
        const running = pending.get(query);
        if (running) {
          // Repeated foreground/periodic checks can join. Concrete events and
          // a newly connected replica need a snapshot after an earlier read.
          if (requireNewSnapshot) running.dirty = true;
          work.push(running.promise);
        } else if (query.isActive() && !query.isDisabled()) {
          const entry: PendingRead = { dirty: false, promise: Promise.resolve() };
          pending.set(query, entry);
          entry.promise = drain(query, entry);
          work.push(entry.promise);
        }
      }
      return Promise.all(work).then(() => {});
    },
    dispose() { disposed = true; pending.clear(); },
  };
}
