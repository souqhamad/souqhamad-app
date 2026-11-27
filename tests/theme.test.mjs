import test from "node:test";
import assert from "node:assert/strict";
import { darkColors, lightColors, normalizeThemePreference, resolveColorScheme } from "../src/ui/theme.ts";

test("appearance follows the device only when system is selected", () => {
  assert.equal(resolveColorScheme("system", "dark"), "dark");
  assert.equal(resolveColorScheme("system", "light"), "light");
  assert.equal(resolveColorScheme("system", null), "light");
  assert.equal(resolveColorScheme("light", "dark"), "light");
  assert.equal(resolveColorScheme("dark", "light"), "dark");
  for (const invalid of [null, undefined, "", "automatic", "blue", {}, 0]) {
    assert.equal(normalizeThemePreference(invalid), "system");
  }
});

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map(value => {
    const channel = parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
for (const [name, colors] of Object.entries({ light: lightColors, dark: darkColors })) {
  test(`${name} palette keeps reading, actions and validation legible`, () => {
    for (const surface of ["background", "surface", "card"]) {
      for (const text of ["text", "muted", "primary", "danger"]) {
        assert.ok(contrast(colors[text], colors[surface]) >= 4.5, `${name} ${text} on ${surface}`);
      }
    }
    assert.ok(contrast(colors.onPrimary, colors.primaryFill) >= 4.5);
    assert.ok(contrast(colors.onPrimary, colors.dangerFill) >= 4.5);
    assert.deepEqual(Object.keys(colors).sort(), Object.keys(lightColors).sort());
  });
}
