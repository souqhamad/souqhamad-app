import test from "node:test";
import assert from "node:assert/strict";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { eventInvalidatesQuery, isRealtimeQuery } from "../src/core/realtime-query-invalidation.ts";

const user = "owner";
const keys = [
  ["bootstrap"], ["device-push-state", user], ["account", user, "commission-payment-methods"],
  ["marketplace", "cars"], ["listing", "ad"], ["listing", "other-ad"], ["seller", user],
  ["my-listings", user], ["owned-listing", user, "ad"], ["owned-listing", "other", "ad"],
  ["account", user, "favorites"], ["account", user, "conversations"], ["account", user, "conversations", "alert"],
  ["account", user, "conversation", "chat"], ["account", user, "conversation", "other-chat"],
  ["account", "other", "conversation", "chat"], ["account", user, "commissions"], ["account", user, "notifications"],
];
const affected = event => keys.filter(key => eventInvalidatesQuery(event, key, user));

test("chat events update only this account's list, unread badge and matching conversation", () => {
  assert.deepEqual(affected({ type: "message_created", payload: { conversationId: "chat", listingId: "ad" } }), keys.slice(11, 14));
});
test("image updates refresh related public and owned listing snapshots without restarting conversations", () => {
  const result = affected({ type: "ad_updated", payload: { listingId: "ad", sellerId: user, reason: "image_added" } });
  assert.deepEqual(result, [keys[3], keys[4], keys[6], keys[7], keys[8], keys[10]]);
});
test("commission and notification events do not refresh unrelated marketplace images", () => {
  assert.deepEqual(affected({ type: "commission_updated", payload: { listingId: "ad" } }), [keys[16]]);
  assert.deepEqual(affected({ type: "listing_notification_created", payload: { listingId: "ad" } }), [keys[17]]);
});
test("replica/reconnect reconciliation excludes configuration and every other account", () => {
  assert.ok(!isRealtimeQuery(["account", "other", "favorites"], user));
  assert.ok(!isRealtimeQuery(["owned-listing", "other", "ad"], user));
  for (const key of keys.slice(0, 3)) assert.equal(isRealtimeQuery(key, user), false);
  assert.equal(isRealtimeQuery(["listing", "ad"], null), true);
  assert.equal(isRealtimeQuery(["account", user, "favorites"], null), false);
});
test("maintenance conservatively reconciles live data while malformed and unknown events remain bounded", () => {
  assert.deepEqual(affected({ type: "maintenance_cleanup" }), keys.filter(key => isRealtimeQuery(key, user)));
  assert.deepEqual(affected({ type: "unrecognized", payload: null }), []);
});
test("targeted invalidation leaves the unrelated conversation QueryClient state fresh", async () => {
  const client = new QueryClient();
  for (const key of keys) client.setQueryData(key, { fixture: true });
  const event = { type: "message_created", payload: { conversationId: "chat" } };
  await client.invalidateQueries({ predicate: query => eventInvalidatesQuery(event, query.queryKey, user) });
  assert.equal(client.getQueryState(keys[13]).isInvalidated, true);
  assert.equal(client.getQueryState(keys[14]).isInvalidated, false);
  assert.equal(client.getQueryState(keys[3]).isInvalidated, false);
  client.clear();
});

test("any candidate listing change reconciles similar cards while base detail stays targeted", () => {
  const similarKey = ["listing", "source", "similar"];
  for (const type of ["ad_created", "ad_updated", "ad_deleted", "ad_status_changed"]) {
    const event = { type, payload: { listingId: "candidate" } };
    assert.equal(eventInvalidatesQuery(event, similarKey, null), true);
    assert.equal(eventInvalidatesQuery(event, ["listing", "source"], null), false);
  }
  assert.equal(eventInvalidatesQuery({ type: "moderation_updated", payload: { entity: "listing", entityId: "candidate" } }, similarKey), true);
  assert.equal(eventInvalidatesQuery({ type: "message_created", payload: { listingId: "candidate" } }, similarKey), false);
  assert.equal(isRealtimeQuery(similarKey, null), true, "Periodic/reconnect reconciliation includes public similar views");
});

test("an active similar view refreshes after candidate deletion without reloading source details", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const key = ["listing", "source", "similar"];
  let candidates = ["candidate"], requests = 0;
  const observer = new QueryObserver(client, { queryKey: key, queryFn: async () => { requests++; return [...candidates]; } });
  const stop = observer.subscribe(() => {});
  await observer.refetch();
  client.setQueryData(["listing", "source"], { listing: { id: "source" } });
  candidates = [];
  await client.invalidateQueries({ predicate: query => eventInvalidatesQuery({ type: "ad_deleted", payload: { listingId: "candidate" } }, query.queryKey) });
  assert.deepEqual(client.getQueryData(key), []);
  assert.equal(requests, 2);
  assert.equal(client.getQueryState(["listing", "source"]).isInvalidated, false);
  stop(); client.clear();
});
