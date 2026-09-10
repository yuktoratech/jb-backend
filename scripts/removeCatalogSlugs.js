require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const { inspectCatalogSlugs, removeCatalogSlugs } = require('../src/modules/catalogMigration/removeCatalogSlugsMigration.service');

const apply = process.argv.includes('--apply');

const run = async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  await mongoose.connect(process.env.MONGODB_URI);
  const result = apply ? await removeCatalogSlugs() : await inspectCatalogSlugs();
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', result }, null, 2));
};

run()
  .catch((error) => {
    console.error(`Catalog slug migration failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
