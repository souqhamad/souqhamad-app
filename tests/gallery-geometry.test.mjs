import test from "node:test";
import assert from "node:assert/strict";
import { getGalleryNeighbourIndexes, getGalleryPageIndex, getGalleryPanBounds, resolveGallerySelection } from "../src/ui/gallery-geometry.ts";

test("landscape zoom cannot move the image out of a portrait viewport", () => {
  assert.deepEqual(getGalleryPanBounds(400, 800, 1800, 900, 5), {
    maxX: 800,
    maxY: 100,
  });
  assert.deepEqual(getGalleryPanBounds(400, 800, 1800, 900, 2.5), {
    maxX: 300,
    maxY: 0,
  });
});

test("portrait and square images clamp to their actual contained dimensions", () => {
  assert.deepEqual(getGalleryPanBounds(800, 400, 900, 1800, 5), {
    maxX: 100,
    maxY: 800,
  });
  assert.deepEqual(getGalleryPanBounds(400, 800, 1000, 1000, 2.5), {
    maxX: 300,
    maxY: 100,
  });
});

test("unzoomed or unloaded images remain centered", () => {
  for (const [imageWidth, imageHeight] of [[1800, 900], [900, 1800], [0, 0]]) {
    assert.deepEqual(getGalleryPanBounds(400, 800, imageWidth, imageHeight, 1), {
      maxX: 0,
      maxY: 0,
    });
  }
  assert.deepEqual(getGalleryPanBounds(0, 800, 1800, 900, 5), {
    maxX: 0,
    maxY: 0,
  });
});

test("gallery paging uses the measured viewport and clamps native overscroll", () => {
  assert.equal(getGalleryPageIndex(3 * 368, 368, 8), 3);
  assert.equal(getGalleryPageIndex(2.7 * 368, 368, 8), 3);
  assert.equal(getGalleryPageIndex(-40, 368, 8), 0);
  assert.equal(getGalleryPageIndex(10 * 368, 368, 8), 7);
  assert.equal(getGalleryPageIndex(200, 0, 8), 0);
  assert.equal(getGalleryPageIndex(Number.NaN, 368, 8), 0);
});

test("an eight-photo gallery prefetches only immediate neighbours", () => {
  assert.deepEqual(getGalleryNeighbourIndexes(0, 8), [1]);
  assert.deepEqual(getGalleryNeighbourIndexes(4, 8), [3, 5]);
  assert.deepEqual(getGalleryNeighbourIndexes(7, 8), [6]);
  assert.deepEqual(getGalleryNeighbourIndexes(0, 1), []);
});

test("gallery selection keeps a photo ID through reordering and earlier removals", () => {
  const images = ["a", "b", "c", "d"].map(id => ({ id }));
  const selected = resolveGallerySelection(images, { index: 2 });
  assert.deepEqual(selected, { id: "c", index: 2 });
  assert.equal(resolveGallerySelection(images, selected), selected, "Unchanged selection must stay referentially stable");
  assert.deepEqual(resolveGallerySelection([images[3], images[2], images[0]], selected), { id: "c", index: 1 });
  assert.deepEqual(resolveGallerySelection([images[2]], selected), { id: "c", index: 0 });
});

test("removed gallery selections fall back to the nearest available ordinal safely", () => {
  const images = ["a", "b", "c"].map(id => ({ id }));
  assert.deepEqual(resolveGallerySelection(images, { id: "removed", index: 6 }), { id: "c", index: 2 });
  assert.deepEqual(resolveGallerySelection(images, { id: "removed", index: 1 }), { id: "b", index: 1 });
  for (const index of [-10, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(resolveGallerySelection(images, { index }), { id: "a", index: 0 });
  }
  assert.deepEqual(resolveGallerySelection(images, { index: 1.8 }), { id: "b", index: 1 });
  const empty = resolveGallerySelection([], { id: "removed", index: 6 });
  assert.deepEqual(empty, { index: 0 });
  assert.equal(resolveGallerySelection([], empty), empty);
});
