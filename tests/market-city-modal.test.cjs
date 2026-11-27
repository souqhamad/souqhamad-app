const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(
  path.join(__dirname, "../src/features/marketplace/market-screen.tsx"),
  "utf8",
);

test("city selector modal uses native responders and closes after selection", () => {
  const modalStart = source.indexOf('<Modal visible={cityOpen}');
  const modalEnd = source.indexOf("</Modal>", modalStart);
  assert.notEqual(modalStart, -1, "city selector modal exists");
  assert.notEqual(modalEnd, -1, "city selector modal is closed");
  const modal = source.slice(modalStart, modalEnd);

  assert.match(source, /Pressable as NativePressable/);
  assert.match(modal, /onRequestClose={closeCity}/);
  assert.match(modal, /<NativePressable[^>]+onPress={closeCity}/);
  assert.match(modal, /<NativePressable[^>]+accessibilityLabel=\{city\}/);
  assert.doesNotMatch(modal, /<Pressable\b/);
  assert.match(modal, /setFilters\(current => \(\{ \.\.\.current, city: value \}\)\); closeCity\(\)/);
});
