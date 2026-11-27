// Read public catalog and policy definitions as data from the server checkout.
const fs = require('node:fs');
const path = require('node:path');
const { readCatalogData } = require('./read-catalog-data.cjs');
const appRoot = path.resolve(__dirname, '..');
const catalogFiles = ['lib/marketplace/categories.ts', 'lib/marketplace/category-options.ts', 'lib/marketplace/car-models.ts', 'lib/marketplace/cities.ts', 'lib/platform/policies.ts'];
// Support sibling release folders and the existing development checkouts.
// Detect only the public modules; never load server config.
const serverRoot = process.env.SMARTSTORE_SERVER_ROOT
  ? path.resolve(process.env.SMARTSTORE_SERVER_ROOT)
  : [path.resolve(appRoot, '..'), path.resolve(appRoot, '../server'), path.resolve(appRoot, '../SmartStoreAI')].find(candidate =>
    catalogFiles.every(relative => fs.existsSync(path.join(candidate, relative))));
if (!serverRoot)
  throw new Error('Cannot find the public server catalog modules. Set SMARTSTORE_SERVER_ROOT to the server repository root.');
const [categories, categoryOptions, carModels, cities, policies] = catalogFiles.map(relative =>
  readCatalogData(path.join(serverRoot, relative)));
const marketplaceCategoryDefinitions = categories.value('marketplaceCategoryDefinitions');
const marketplaceCategoryOptionGroups = categoryOptions.value('marketplaceCategoryOptionGroups');
const marketplaceCarModelsByBrand = carModels.value('marketplaceCarModelsByBrand');
const saudiMarketplaceCities = cities.value('saudiMarketplaceCities');
const snapshot = {
  catalogDate: '2026-10-23',
  categories: marketplaceCategoryDefinitions.map(category => ({...category,
    options: marketplaceCategoryOptionGroups[category.id].options,
    optionKind: marketplaceCategoryOptionGroups[category.id].kind,
    optionLabel: categoryOptions.optionLabel(category.id),
    ...(category.id === 'cars' ? {carModels: marketplaceCarModelsByBrand} : {}),
  })),
  cities: saudiMarketplaceCities,
  policies: policies.value('platformPolicies'),
  attributes: {
    categoryOption: categoryOptions.value('marketplaceCategoryOptionAttribute'),
    carModel: carModels.value('marketplaceCarModelAttribute'),
  },
};
const target = path.join(appRoot, 'src/core/market-catalog.json');
// Coordinates are a maintained mobile artifact. The server homepage is now an
// app landing page, so it is no longer an authoritative source to scrape.
const coordinates = JSON.parse(fs.readFileSync(path.join(appRoot, 'src/core/city-coordinates.json'), 'utf8'));
if (!Array.isArray(coordinates) || !coordinates.length)
  throw new Error('The mobile city coordinates must be a nonempty array.');
const seenCities = new Set();
for (const entry of coordinates) {
  if (!entry || typeof entry !== 'object' || !saudiMarketplaceCities.includes(entry.city) ||
      seenCities.has(entry.city) || !Number.isFinite(entry.latitude) || !Number.isFinite(entry.longitude) ||
      entry.latitude < -90 || entry.latitude > 90 || entry.longitude < -180 || entry.longitude > 180)
    throw new Error('Mobile city coordinates contain an unknown/duplicate city or invalid latitude/longitude.');
  seenCities.add(entry.city);
}
// Complete every validation before writing the updated public catalog. Preserve
// the checked-in coordinates exactly, including their order and precision.
fs.writeFileSync(target, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
console.log(`Updated public catalog: ${snapshot.categories.length} categories, ${new Set(snapshot.categories.map(c=>c.group)).size} groups, ${snapshot.cities.length} cities.`);
