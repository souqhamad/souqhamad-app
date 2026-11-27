import assert from "node:assert/strict";
import test from "node:test";
import { parseSimilarListings } from "../src/core/similar-listings.ts";

const listing = (id, fields = {}) => ({ id, sellerId: "seller", category: "cars", status: "published", images: [], attributes: {}, ...fields });

test("similar view keeps server ranking and real card identity, capped at twenty without filler", () => {
  const candidates = Array.from({ length: 25 }, (_, index) => listing(`candidate-${index}`));
  const result = parseSimilarListings({ listings: candidates }, "source");
  assert.deepEqual(result, candidates.slice(0, 20));
  assert.equal(result[0], candidates[0]);
  assert.deepEqual(parseSimilarListings({ listings: candidates.slice(0, 3) }, "source"), candidates.slice(0, 3));
  assert.deepEqual(parseSimilarListings({ listings: [] }, "source"), []);
});

test("the source, duplicate and nonpublic ads never become similar cards", () => {
  const first = listing("first");
  const result = parseSimilarListings({ listings: [listing("source"), first, listing("first"), listing("sold", { status: "sold" }), listing("second")] }, "source");
  assert.deepEqual(result.map(item => item.id), ["first", "second"]);
});

test("old-server detail responses and invalid card shapes fail the independent similar view", () => {
  for (const value of [null, {}, { listing: listing("source") }, { listings: null }, { listings: [null] }, { listings: [listing("broken", { images: [null] })] }])
    assert.throws(() => parseSimilarListings(value, "source"));
});
