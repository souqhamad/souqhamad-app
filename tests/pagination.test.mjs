import assert from "node:assert/strict";
import test from "node:test";
import { nextListingPage, uniqueListings } from "../src/core/pagination.ts";

test("pagination advances only when the server offers a later page", () => {
  const page = { page: 2, limit: 24, hasMore: true, nextPage: 3 };
  assert.equal(nextListingPage(page, 2), 3);
  for (const nextPage of [null, 0, 1, 2, 2.5, NaN, Infinity]) {
    assert.equal(nextListingPage({ ...page, nextPage }, 2), undefined);
  }
  assert.equal(nextListingPage({ ...page, hasMore: false }, 2), undefined);
});

test("overlapping pages retain order and update duplicate records without duplicate cards", () => {
  const result = uniqueListings([
    { listings: [{ id: "first", title: "قديم" }, { id: "second", title: "إعلان" }] },
    { listings: [{ id: "first", title: "محدّث" }, { id: "third", title: "جديد" }] },
  ]);
  assert.deepEqual(result.map(item => item.id), ["first", "second", "third"]);
  assert.equal(result[0].title, "محدّث");
});
