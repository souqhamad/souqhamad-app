const BASE_BUILD_NUMBER = 433;
const MAX_ANDROID_VERSION_CODE = 2_100_000_000;

/**
 * Codemagic's project counter spans workflows, unlike BUILD_NUMBER.
 * The floor is above confirmed Google Play code 432 for release 1.0.57.
 * Keep the continuing project counter monotonic; compare the floor with
 * the highest store code again before any later project/counter reset.
 * Local builds and EAS retain their own configured versioning behavior.
 * @param {Record<string, string | undefined>} environment
 * @returns {number}
 */
function resolveNativeBuildNumber(environment) {
  if (!environment.CM_BUILD_ID) return BASE_BUILD_NUMBER;

  const counter = environment.PROJECT_BUILD_NUMBER;
  if (!counter || !/^[1-9]\d*$/.test(counter)) {
    throw new Error(
      "Codemagic requires PROJECT_BUILD_NUMBER to be a positive integer for native build versioning.",
    );
  }

  const projectBuildNumber = Number(counter);
  const nativeBuildNumber = BASE_BUILD_NUMBER + projectBuildNumber;
  if (
    !Number.isSafeInteger(projectBuildNumber) ||
    nativeBuildNumber > MAX_ANDROID_VERSION_CODE
  ) {
    throw new Error(
      "Codemagic native build number exceeds the Android versionCode limit (2100000000).",
    );
  }
  return nativeBuildNumber;
}

module.exports = { resolveNativeBuildNumber };

if (require.main === module) {
  try {
    if (process.argv.includes("--codemagic") && !process.env.CM_BUILD_ID) {
      throw new Error("CM_BUILD_ID is required for Codemagic release versioning.");
    }
    const buildNumber = resolveNativeBuildNumber(process.env);
    const version = require("../package.json").version;
    const gradleArgument = process.argv.indexOf("--android-gradle");
    if (gradleArgument !== -1) {
      const gradlePath = process.argv[gradleArgument + 1];
      if (!gradlePath) throw new Error("--android-gradle requires a generated build.gradle path.");
      const gradle = require("node:fs").readFileSync(gradlePath, "utf8");
      const actualCode = gradle.match(/^\s*versionCode\s+(\d+)\s*$/m)?.[1];
      const actualVersion = gradle.match(/^\s*versionName\s+["']([^"']+)["']\s*$/m)?.[1];
      if (Number(actualCode) !== buildNumber || actualVersion !== version) {
        throw new Error(`Generated Android version must be ${version} (${buildNumber}); found ${actualVersion ?? "missing"} (${actualCode ?? "missing"}).`);
      }
    }
    console.log(JSON.stringify({ version, androidVersionCode: buildNumber, iosBuildNumber: String(buildNumber) }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
