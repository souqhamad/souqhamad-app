import test from "node:test";
import assert from "node:assert/strict";
import { QueryClient, QueryObserver, InfiniteQueryObserver } from "@tanstack/react-query";
import { createRealtimeQueryRefresh } from "../src/core/realtime-query-refresh.ts";
import { createSessionRefresh } from "../src/core/session-refresh.ts";
import { cancelUnusedQueryRead, runVisibleQueryRead } from "../src/core/visible-query-read.ts";
import { eventInvalidatesQuery } from "../src/core/realtime-query-invalidation.ts";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const makeClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });

test("twenty listing events preserve five-page ordering with two reads and no cancellation", async () => {
  const client = makeClient();
  const first = deferred();
  let records = Array.from({ length: 120 }, (_, i) => `ad-${i}`);
  let requests = 0, aborts = 0;
  const page = number => ({ ids: records.slice((number - 1) * 24, number * 24), nextPage: number < 5 ? number + 1 : undefined });
  const observer = new InfiniteQueryObserver(client, {
    queryKey: ["marketplace", "", { city: "الرياض" }], initialPageParam: 1,
    initialData: { pages: [1, 2, 3, 4, 5].map(page), pageParams: [1, 2, 3, 4, 5] },
    getNextPageParam: result => result.nextPage,
    queryFn: async ({ pageParam, signal }) => {
      requests++;
      signal.addEventListener("abort", () => { aborts++; });
      const snapshot = page(pageParam);
      if (requests === 1) await first.promise;
      return snapshot;
    },
  });
  const stop = observer.subscribe(() => {});
  const reads = createRealtimeQueryRefresh(client, () => true);
  const event = { type: "ad_updated", payload: { listingId: "ad-100", reason: "favorite_count" } };
  const affected = query => eventInvalidatesQuery(event, query.queryKey);
  const pending = reads.refresh(affected);
  assert.equal(requests, 1, "the first affected GET starts immediately");
  records = ["ad-115", ...records.filter(id => id !== "ad-115" && id !== "ad-9"), "new-ad"];
  for (let i = 0; i < 19; i++) void reads.refresh(affected);
  assert.equal(requests, 1, "events share the current page sequence");
  first.resolve();
  await pending;
  assert.equal(requests, 10, "one five-page read plus one authoritative catch-up");
  assert.equal(aborts, 0);
  assert.deepEqual(observer.getCurrentResult().data.pages.flatMap(result => result.ids), records);
  reads.dispose(); stop(); client.clear();
});

test("repeated foreground checks join while an event during that read still catches up", async () => {
  const client = makeClient(), gate = deferred();
  let requests = 0;
  const observer = new QueryObserver(client, { queryKey: ["listing", "ad"], initialData: 0,
    queryFn: async () => { const value = ++requests; if (value === 1) await gate.promise; return value; } });
  const stop = observer.subscribe(() => {});
  const reads = createRealtimeQueryRefresh(client, () => true);
  const pending = reads.refresh(() => true, false);
  for (let i = 0; i < 10; i++) void reads.refresh(() => true, false);
  assert.equal(requests, 1);
  void reads.refresh(() => true);
  gate.resolve(); await pending;
  assert.equal(requests, 2);
  assert.equal(observer.getCurrentResult().data, 2);
  reads.dispose(); stop(); client.clear();
});

test("SSE connection after a captured snapshot reconciles changes from another replica immediately", async () => {
  const client = makeClient(), gate = deferred(); let server = "before-connection", requests = 0;
  const observer = new QueryObserver(client, { queryKey: ["listing", "ad"], initialData: "cached",
    queryFn: async () => {
      const snapshot = server; requests++;
      if (requests === 1) await gate.promise;
      return snapshot;
    } });
  const stop = observer.subscribe(() => {}), reads = createRealtimeQueryRefresh(client, () => true);
  const foreground = reads.refresh(() => true, false);
  server = "updated-by-another-replica";
  const connected = reads.refresh(() => true, true);
  assert.equal(requests, 1, "the connection barrier does not cancel the in-flight GET");
  gate.resolve(); await Promise.all([foreground, connected]);
  assert.equal(requests, 2);
  assert.equal(observer.getCurrentResult().data, "updated-by-another-replica");
  reads.dispose(); stop(); client.clear();
});

test("an event behind an already-running GET is not lost", async () => {
  const client = makeClient(), gate = deferred();
  let requests = 0, aborts = 0;
  const observer = new QueryObserver(client, { queryKey: ["listing", "ad"], queryFn: async ({ signal }) => {
    signal.addEventListener("abort", () => { aborts++; });
    const value = ++requests; if (value === 1) await gate.promise; return value;
  } });
  const stop = observer.subscribe(() => {});
  const reads = createRealtimeQueryRefresh(client, () => true);
  const pending = reads.refresh(() => true);
  assert.equal(requests, 1);
  gate.resolve(); await pending;
  assert.equal(requests, 2);
  assert.equal(aborts, 0);
  reads.dispose(); stop(); client.clear();
});

test("hidden queries stay invalidated and fetch only after a visible reader returns", async () => {
  const client = makeClient(); let requests = 0;
  const options = { queryKey: ["marketplace", "", { city: "جدة" }], initialData: "old", enabled: false,
    queryFn: async () => { requests++; return "latest"; } };
  const observer = new QueryObserver(client, options), stop = observer.subscribe(() => {});
  const reads = createRealtimeQueryRefresh(client, () => true);
  await reads.refresh(() => true);
  assert.equal(requests, 0);
  assert.equal(client.getQueryState(options.queryKey).isInvalidated, true);
  observer.setOptions({ ...options, enabled: true }); await tick();
  assert.equal(requests, 1);
  assert.equal(observer.getCurrentResult().data, "latest");
  reads.dispose(); stop(); client.clear();
});

test("an account change/disposal prevents queued reads from crossing identity boundaries", async () => {
  const client = makeClient(), gate = deferred(); let current = true, requests = 0;
  const observer = new QueryObserver(client, { queryKey: ["account", "old", "favorites"], initialData: [],
    queryFn: async () => { requests++; await gate.promise; return ["old-account"]; } });
  const stop = observer.subscribe(() => {}), reads = createRealtimeQueryRefresh(client, () => current);
  const pending = reads.refresh(() => true); void reads.refresh(() => true);
  current = false; reads.dispose(); gate.resolve(); await pending;
  assert.equal(requests, 1);
  await reads.refresh(() => true); assert.equal(requests, 1);
  stop(); client.clear();
});

test("hiding one reader preserves a shared GET; hiding its last reader aborts only that GET", async () => {
  const client = makeClient(), gate = deferred(), write = deferred(); let aborted = false, written = false;
  const options = { queryKey: ["seller", "owner", "summary"], queryFn: async ({ signal }) => {
    signal.addEventListener("abort", () => { aborted = true; }); await gate.promise; return "seller";
  } };
  const first = new QueryObserver(client, options), second = new QueryObserver(client, options);
  const stop1 = first.subscribe(() => {}), stop2 = second.subscribe(() => {});
  const mutation = client.getMutationCache().build(client, { mutationFn: async () => { await write.promise; written = true; } });
  const saving = mutation.execute();
  first.setOptions({ ...options, enabled: false });
  await cancelUnusedQueryRead(client, options.queryKey); assert.equal(aborted, false);
  second.setOptions({ ...options, enabled: false });
  await cancelUnusedQueryRead(client, options.queryKey); assert.equal(aborted, true);
  assert.equal(mutation.state.status, "pending");
  write.resolve(); await saving; assert.equal(written, true);
  gate.resolve(); stop1(); stop2(); client.clear();
});

test("session refresh shares concurrent work but neither caches results nor shares accounts/epochs", async () => {
  const refresh = createSessionRefresh(), old = deferred(), next = deferred(); let requests = 0;
  const identity = { token: "old", generation: 1, epoch: 1 };
  const first = refresh(identity, async () => { requests++; await old.promise; });
  assert.equal(refresh(identity, async () => { requests++; }), first);
  await tick(); assert.equal(requests, 1);
  const changed = { token: "new", generation: 2, epoch: 2 };
  const second = refresh(changed, async () => { requests++; await next.promise; });
  old.resolve(); await first;
  assert.equal(refresh(changed, async () => { requests++; }), second, "old completion cannot clear the new owner's request");
  next.resolve(); await second;
  await refresh(changed, async () => { requests++; }); assert.equal(requests, 3);
  await refresh({ ...changed, epoch: 3 }, async () => { requests++; }); assert.equal(requests, 4);
});

test("a hidden mutation callback cannot force GET refetch, but another visible reader can", async () => {
  const client = makeClient(); let requests = 0;
  const options = { queryKey: ["account", "owner", "notifications"], initialData: "old", enabled: false,
    queryFn: async () => { requests++; return "new"; } };
  const observer = new QueryObserver(client, options), stop = observer.subscribe(() => {});
  const hash = client.getQueryCache().find({ queryKey: options.queryKey }).queryHash;
  const skipped = observer.getCurrentResult();
  await runVisibleQueryRead(client, hash, true, () => observer.refetch(), skipped);
  assert.equal(requests, 0);
  assert.equal(client.getQueryState(options.queryKey).isInvalidated, true);
  observer.setOptions({ ...options, enabled: true }); await tick();
  assert.equal(requests, 1);
  await runVisibleQueryRead(client, hash, false, () => observer.refetch(), skipped);
  assert.equal(requests, 1, "background skips even when the screen's observer has not rerendered yet");
  await runVisibleQueryRead(client, hash, true, () => observer.refetch(), skipped);
  assert.equal(requests, 2);
  stop(); client.clear();
});

test("profile writes during a session GET obtain one subsequent snapshot", async () => {
  const refresh = createSessionRefresh(), gate = deferred();
  const identity = { token: "owner", generation: 1, epoch: 1 };
  let serverName = "old", shownName, requests = 0;
  const read = async () => {
    requests++; const snapshot = serverName;
    if (requests === 1) await gate.promise;
    shownName = snapshot;
  };
  const pending = refresh(identity, read); await tick();
  serverName = "new";
  for (let i = 0; i < 10; i++) assert.equal(refresh(identity, read, true), pending);
  gate.resolve(); await pending;
  assert.equal(requests, 2);
  assert.equal(shownName, "new");
});
