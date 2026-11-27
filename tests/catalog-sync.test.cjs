const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function syncCatalog(coordinates, categoriesSource = "throw new Error('Do not execute catalog source'); export const marketplaceCategoryDefinitions = [{id:'cars',label:'New server category',group:'vehicles'}];") {
  const appRoot = path.resolve(__dirname, "..");
  const serverRoot = path.resolve(appRoot, "fixture-server");
  const script = path.join(appRoot, "scripts/sync-market-catalog.cjs");
  const fixtures = new Map([
    ["lib/marketplace/categories.ts", categoriesSource],
    ["lib/marketplace/category-options.ts", "export const marketplaceCategoryOptionGroups = {cars:{kind:'brand',options:[{id:'toyota',label:'Toyota'}]}}; export const getMarketplaceCategoryOptionLabel = () => 'Brand'; export const marketplaceCategoryOptionAttribute = 'marketplaceCategoryOption';"],
    ["lib/marketplace/car-models.ts", "export const marketplaceCarModelsByBrand = {toyota:[{id:'camry',label:'Camry'}]}; export const marketplaceCarModelAttribute = 'marketplaceCarModel';"],
    ["lib/marketplace/cities.ts", "export const saudiMarketplaceCities = ['الرياض','جدة'];"],
    ["lib/platform/policies.ts", "export const platformPolicies = {terms:{title:'Current server policy'}};"],
  ].map(([relative, contents]) => [path.join(serverRoot, relative), contents]));
  fixtures.set(path.join(appRoot, "src/core/city-coordinates.json"), typeof coordinates === "string" ? coordinates : JSON.stringify(coordinates));
  const writes = [];
  const load = filename => {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
      __dirname: path.dirname(filename),
      module,
      process: { env: { SMARTSTORE_SERVER_ROOT: serverRoot } },
      console: { log: () => {} },
      require: id => {
        if (id === "node:fs") return {
          readFileSync: filename => {
            assert.ok(fixtures.has(filename), `Unexpected file read ${filename}`);
            return fixtures.get(filename);
          },
          writeFileSync: (filename, value) => writes.push({ filename, value }),
        };
        if (id === "node:path") return path;
        if (id === "typescript") return ts;
        if (id === "./read-catalog-data.cjs") return load(path.join(path.dirname(filename), id));
        throw new Error(`Unexpected module ${id}`);
      },
    }, { filename });
    return module.exports;
  };
  return { run: () => load(script), writes };
}

test("catalog sync reads shared server definitions and preserves mobile coordinates without the retired homepage", () => {
  const harness = syncCatalog([{ city: "الرياض", latitude: 24.7136, longitude: 46.6753 }]);
  harness.run();
  assert.equal(harness.writes.length, 1);
  assert.match(harness.writes[0].filename, /market-catalog\.json$/);
  const catalog = JSON.parse(harness.writes[0].value);
  assert.equal(catalog.categories[0].label, "New server category");
  assert.equal(catalog.categories[0].options[0].id, "toyota");
  assert.equal(catalog.categories[0].carModels.toyota[0].id, "camry");
  assert.equal(catalog.policies.terms.title, "Current server policy");
  assert.deepEqual(catalog.cities, ["الرياض", "جدة"]);
});

test("invalid coordinate artifacts abort catalog sync before any file is written", () => {
  const valid = { city: "الرياض", latitude: 24.7, longitude: 46.6 };
  for (const artifact of [[], {}, "{invalid-json", [{ ...valid, city: "unknown-city" }], [valid, valid], [{ ...valid, latitude: 91 }], [{ ...valid, longitude: -181 }], [{ ...valid, latitude: "24.7" }], [null]]) {
    const harness = syncCatalog(artifact);
    assert.throws(harness.run);
    assert.equal(harness.writes.length, 0, "invalid artifacts must not partially update the catalog");
  }
});

test("catalog sync rejects unsupported expressions before updating the snapshot", () => {
  const harness = syncCatalog([{ city: "الرياض", latitude: 24.7, longitude: 46.6 }],
    "export const marketplaceCategoryDefinitions = loadCategories();");
  assert.throws(harness.run, /Unsupported catalog expression/);
  assert.equal(harness.writes.length, 0);
});

test("catalog sync only reads constant variable declarations", () => {
  for (const keyword of ["let", "var"]) {
    const harness = syncCatalog([{ city: "الرياض", latitude: 24.7, longitude: 46.6 }],
      `export ${keyword} marketplaceCategoryDefinitions = [{id:'cars',label:'Updated category',group:'vehicles'}];`);
    assert.throws(harness.run, /Missing catalog definition marketplaceCategoryDefinitions/);
    assert.equal(harness.writes.length, 0);
  }
});
