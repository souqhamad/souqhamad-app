import assert from "node:assert/strict";
import test from "node:test";
import { buildEditorImages } from "../src/features/listing-editor/editor-images.ts";

const photo = id => ({ id, isPrimary: id === "one", displayUrl: `https://images.invalid/${id}-display.webp`,
  thumbnailUrl: `https://images.invalid/${id}-thumbnail.webp`, originalUrl: `https://images.invalid/${id}-display.webp` });
const asset = id => ({ uri: `file:///cache/${id}.jpg` });
const resolve = url => url?.startsWith("https://") ? url : undefined;

test("a ready image occupies one tile while other transfers remain queued", () => {
  const assets = [asset("one"), asset("two")];
  const rows = buildEditorImages([photo("one")], assets, new Map(), uri => uri === assets[0].uri ? "one" : "two", resolve);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "one");
  assert.equal(rows[0].localUri, assets[0].uri);
  assert.equal(rows[0].saved, true);
  assert.equal(rows[1].saved, false);
});

test("eight completed transfers retain eight local fallbacks after removing the upload queue", () => {
  const ids = Array.from({ length: 8 }, (_, i) => String(i));
  const previews = new Map(ids.map(id => [id, asset(id).uri]));
  const queued = ids.map(asset);
  const before = buildEditorImages(ids.map(photo), queued, previews, uri => uri.split("/").at(-1).split(".")[0], resolve);
  const after = buildEditorImages(ids.map(photo), [], previews, () => undefined, resolve);
  assert.equal(before.length, 8);
  assert.deepEqual(after, before);
  assert.deepEqual(after.map(row => row.localUri), ids.map(id => asset(id).uri));
});

test("legacy upload previews are matched by the server's image ID without duplicating tiles", () => {
  const local = asset("legacy");
  const previews = new Map([["one", local.uri]]);
  const rows = buildEditorImages([photo("one")], [local], previews,
    uri => [...previews].find(([, localUri]) => localUri === uri)?.[0], resolve);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].localUri, local.uri);
});

test("delivery sources are validated separately and same-URL aliases are requested once", () => {
  const rows = buildEditorImages([{ ...photo("one"), displayUrl: "http://invalid-source" }], [], new Map(), () => undefined, resolve);
  assert.deepEqual(rows[0].sources, [photo("one").thumbnailUrl, photo("one").originalUrl]);
  assert.equal(buildEditorImages([photo("one")], [], new Map(), () => undefined, resolve)[0].sources.length, 2);
});

test("deleting a saved image does not resurrect it from a retained local preview", () => {
  assert.deepEqual(buildEditorImages([], [], new Map([["removed", asset("removed").uri]]), () => undefined, resolve), []);
});
