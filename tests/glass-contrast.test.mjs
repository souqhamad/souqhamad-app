import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { darkColors, lightColors } from "../src/ui/theme.ts";

// Read the actual navigation configuration instead of duplicating its intensity.
const navigation = ts.createSourceFile("bottom-navigation.tsx", readFileSync(
  new URL("../src/features/navigation/bottom-navigation.tsx", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let blur;
function visit(node) {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(navigation) === "BlurView") blur = node;
  ts.forEachChild(node, visit);
}
visit(navigation);
assert.ok(blur, "navigation must render its backdrop blur");
function expression(name) {
  const attribute = blur.attributes.properties.find(item => item.name?.getText(navigation) === name);
  assert.ok(attribute?.initializer && ts.isJsxExpression(attribute.initializer), `BlurView ${name}`);
  return attribute.initializer.expression;
}
const intensityExpression = expression("intensity");
assert.ok(ts.isNumericLiteral(intensityExpression), "model requires a numeric blur intensity");
const intensity = Number(intensityExpression.text);
const tintExpression = expression("tint");
assert.ok(ts.isConditionalExpression(tintExpression));
assert.ok(ts.isStringLiteral(tintExpression.whenTrue) && ts.isStringLiteral(tintExpression.whenFalse));
const tints = { dark: tintExpression.whenTrue.text, light: tintExpression.whenFalse.text };

// Execute Expo's installed web tint function. iOS uses an OS material and cannot
// be certified by this color model; native visual checks remain necessary.
const exports = {};
const expoTintSource = readFileSync(new URL("../node_modules/expo-blur/src/getBackgroundColor.ts", import.meta.url), "utf8");
vm.runInNewContext(ts.transpileModule(expoTintSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports });

function rgba(value) {
  if (value.startsWith("#")) {
    const channels = value.slice(1).match(/../g).map(channel => parseInt(channel, 16));
    return [...channels.slice(0, 3), (channels[3] ?? 255) / 255];
  }
  return value.match(/[\d.]+/g).map(Number);
}
function over(foreground, background) {
  const alpha = foreground[3];
  return foreground.slice(0, 3).map((channel, index) => channel * alpha + background[index] * (1 - alpha));
}
function luminance(color) {
  return color.slice(0, 3).map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }).reduce((result, channel, index) => result + channel * [0.2126, 0.7152, 0.0722][index], 0);
}
function contrast(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

for (const [name, colors] of Object.entries({ light: lightColors, dark: darkColors })) {
  test(`${name} glass preserves visible backdrop and readable navigation in Expo's web tint model`, () => {
    const material = rgba(exports.default(intensity, tints[name]));
    const wash = rgba(colors.glassTint);
    const transmission = (1 - material[3]) * (1 - wash[3]);
    assert.ok(transmission >= 0.3, `backdrop transmission ${transmission} must retain visible scene color`);
    const foreground = rgba(colors.glassForeground);
    for (const red of [0, 85, 170, 255]) for (const green of [0, 85, 170, 255]) for (const blue of [0, 85, 170, 255]) {
      const scene = [red, green, blue];
      const glass = over(wash, over(material, scene));
      assert.ok(contrast(foreground, glass) >= 4.5, `${name} foreground over ${scene}`);
      assert.ok(contrast(foreground, over(rgba(colors.glassFallback), scene)) >= 4.5, `${name} fallback over ${scene}`);
    }
    assert.ok(contrast(rgba(colors.primary), rgba(colors.primarySoft)) >= 3, "selected circular glyph");
    assert.ok(contrast(rgba(colors.onPrimary), rgba(colors.primaryFill)) >= 4.5, "Home glyph");
  });
}
