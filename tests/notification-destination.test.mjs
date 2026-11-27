import test from "node:test";
import assert from "node:assert/strict";
import { notificationDestination } from "../src/core/notification-destination.ts";

test("server follower notification links open the native listing screen", () => {
  for (const source of ["follow", "similar-follow"]) {
    assert.equal(notificationDestination(`/listings/listing-123?source=${source}`), "/listings/listing-123");
  }
  assert.equal(notificationDestination("/conversations/thread_123"), "/conversations/thread_123");
  assert.equal(notificationDestination("/listings/listing-123#photos"), "/listings/listing-123");
});

test("notification payloads cannot navigate to external hosts or unknown screens", () => {
  for (const value of [undefined, null, 12, "https://example.com/listings/a", "//example.com/listings/a", "/\\example.com/listings/a", "/auth", "/listings", "/listings/a/images", "/listings/a%2Fb", "/conversations/a%0A", "javascript:alert(1)"]) {
    assert.equal(notificationDestination(value), null, String(value));
  }
});
