const fs = require("node:fs");
const path = require("node:path");
const { Buffer } = require("node:buffer");
const optionalHardware = require("../config/android-optional-hardware.json");

function verifyGoogleServices(filename, expectedPackage = "com.souqhamad.app") {
  let data;
  try { data = JSON.parse(fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, "")); }
  catch { throw new Error("Android push configuration is missing or invalid. Supply GOOGLE_SERVICES_JSON or GOOGLE_SERVICES_JSON_BASE64 before prebuild."); }
  if ("private_key" in data || data.type === "service_account")
    throw new Error("Use the Android google-services.json client file, never a server service-account key.");
  const client = data.client?.find(entry => entry.client_info?.android_client_info?.package_name === expectedPackage);
  if (!client || !client.client_info?.mobilesdk_app_id?.includes(":android:") ||
      !client.api_key?.some(entry => typeof entry.current_key === "string" && entry.current_key.length > 10) ||
      !data.project_info?.project_id || !/^\d+$/.test(data.project_info?.project_number ?? ""))
    throw new Error(`Android Firebase configuration must include a registered client for ${expectedPackage}.`);
  return { packageName: expectedPackage, projectId: data.project_info.project_id };
}

function prepareAndroidRelease(env = process.env, appRoot = path.resolve(__dirname, "..")) {
  let filename;
  if (env.GOOGLE_SERVICES_JSON_BASE64) {
    const encoded = env.GOOGLE_SERVICES_JSON_BASE64.replace(/\s/g, "");
    const buffer = Buffer.from(encoded, "base64");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || !buffer.length ||
        buffer.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, ""))
      throw new Error("GOOGLE_SERVICES_JSON_BASE64 must contain a valid base64 client configuration.");
    const directory = path.join(appRoot, ".data");
    fs.mkdirSync(directory, { recursive: true });
    filename = path.join(directory, "google-services.release.json");
    // Validate before making an override available to Expo's native generator.
    const temporary = filename + ".pending";
    fs.writeFileSync(temporary, buffer, { mode: 0o600 });
    try { verifyGoogleServices(temporary); fs.renameSync(temporary, filename); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  } else {
    filename = path.resolve(appRoot, env.GOOGLE_SERVICES_JSON || "config/google-services.production.json");
  }
  if (/[\r\n]/.test(filename)) throw new Error("Invalid Android configuration path.");
  const result = verifyGoogleServices(filename);
  if (env.CM_ENV) fs.appendFileSync(env.CM_ENV, `GOOGLE_SERVICES_JSON=${filename}\n`, "utf8");
  return result;
}

function verifyGeneratedAndroid(androidRoot) {
  const client = verifyGoogleServices(path.join(androidRoot, "app/google-services.json"));
  const gradle = fs.readFileSync(path.join(androidRoot, "app/build.gradle"), "utf8");
  const manifest = fs.readFileSync(path.join(androidRoot, "app/src/main/AndroidManifest.xml"), "utf8");
  if (!/apply plugin:\s*['"]com\.google\.gms\.google-services['"]/.test(gradle))
    throw new Error("The generated Android build must initialize the Google Services client.");
  if (!/<action\b[^>]*android:name="OPEN_APP"/.test(manifest))
    throw new Error("The generated Android app must handle the server's OPEN_APP notification action.");
  const declaredFeatures = manifest.match(/<uses-feature\b[^>]*>/g) ?? [];
  for (const name of optionalHardware) {
    const entries = declaredFeatures.filter(entry => /\bandroid:name\s*=\s*(["'])([^"']+)\1/.exec(entry)?.[2] === name);
    if (entries.length !== 1 || !/\bandroid:required\s*=\s*(["'])false\1/.test(entries[0])) {
      throw new Error(`The generated Android app must declare ${name} once with android:required="false".`);
    }
  }
  return client;
}

module.exports = { verifyGoogleServices, prepareAndroidRelease, verifyGeneratedAndroid };
if (require.main === module) {
  try {
    const generatedIndex = process.argv.indexOf("--generated");
    if (generatedIndex !== -1 && !process.argv[generatedIndex + 1]) throw new Error("--generated requires an Android project path.");
    const result = generatedIndex === -1 ? prepareAndroidRelease() : verifyGeneratedAndroid(path.resolve(process.argv[generatedIndex + 1]));
    console.log(`Android push configuration verified: ${result.packageName} (${result.projectId}).`);
    if (generatedIndex !== -1) console.log("Portrait screen and Wi-Fi are optional Android hardware features.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
