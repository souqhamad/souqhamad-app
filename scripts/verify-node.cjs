// Match Expo SDK 58's minimum runtime while retaining the project's supported
// Node.js 22 and 24 release lines. Run before package installation on CI.
function verifyNodeVersion(version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("Cannot determine a supported stable Node.js version.");
  const [major, minor] = version.split(".").map(Number);
  if (!((major === 22 && minor >= 13) || (major === 24 && minor >= 3)))
    throw new Error(`Node.js ${version} is unsupported. Use Node.js 22.13+ or 24.3+ within those release lines (Codemagic: 22.23.3).`);
  return version;
}

module.exports = { verifyNodeVersion };

if (require.main === module) {
  try {
    console.log(`Node.js ${verifyNodeVersion(process.versions.node)} is supported.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
