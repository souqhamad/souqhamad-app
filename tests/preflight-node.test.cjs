const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { verifyNodeVersion } = require("../scripts/verify-node.cjs");

test("supported stable Node release lines accept their minimum and later minor releases", () => {
  for (const version of ["22.13.0", "22.23.3", "22.99.1", "24.3.0", "24.14.2"]) {
    assert.equal(verifyNodeVersion(version), version);
  }
});

test("an older or unsupported Node release stops before CI dependency installation", () => {
  for (const version of ["20.19.0", "22.11.0", "22.12.9", "23.0.0", "24.2.9", "25.0.0", "26.0.0"]) {
    assert.throws(() => verifyNodeVersion(version), /unsupported/);
  }
  for (const version of [undefined, "", "v22.23.3", "22.13", "22.13.0-rc.1", "22.13.0foo"]) {
    assert.throws(() => verifyNodeVersion(version), /stable Node/);
  }
});

test("the preflight CLI actually checks its running Node process", () => {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../scripts/verify-node.cjs")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Node\\.js ${process.versions.node.replaceAll(".", "\\.")} is supported`));
});
