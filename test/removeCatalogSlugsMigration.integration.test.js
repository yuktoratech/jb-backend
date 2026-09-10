const assert = require('node:assert/strict');
const { test } = require('node:test');
const mongoose = require('mongoose');

const TEST_DATABASE_URI =
  process.env.REMOVE_CATALOG_SLUGS_TEST_MONGODB_URI ||
  'mongodb://127.0.0.1:27017/jb_b2b_remove_catalog_slugs_test';
const databaseName = new URL(TEST_DATABASE_URI).pathname.slice(1);

if (!/^jb_b2b_remove_catalog_slugs_test(?:_|$)/.test(databaseName)) {
  throw new Error('REMOVE_CATALOG_SLUGS_TEST_MONGODB_URI must target a jb_b2b_remove_catalog_slugs_test database');
}

const Category = require('../src/modules/categories/category.model');
const SubCategory = require('../src/modules/subcategories/subCategory.model');
const Colour = require('../src/modules/colours/colour.model');
const Fit = require('../src/modules/fits/fit.model');
const Fabric = require('../src/modules/fabrics/fabric.model');
const {
  inspectCatalogSlugs,
  removeCatalogSlugs,
} = require('../src/modules/catalogMigration/removeCatalogSlugsMigration.service');

test('catalog slug removal is dry-run safe, complete, and idempotent', async () => {
  await mongoose.connect(TEST_DATABASE_URI);
  try {
    await mongoose.connection.dropDatabase();
    const categoryId = new mongoose.Types.ObjectId();
    const fixtures = [
      { Model: Category, indexName: 'unique_category_slug', key: { slug: 1 }, document: { _id: categoryId, name: 'TOPS', slug: 'tops' } },
      { Model: SubCategory, indexName: 'unique_subcategory_slug_per_category', key: { category: 1, slug: 1 }, document: { category: categoryId, name: 'FORMAL', slug: 'formal' } },
      { Model: Colour, indexName: 'unique_colour_slug', key: { slug: 1 }, document: { name: 'BLACK', slug: 'black' } },
      { Model: Fit, indexName: 'unique_fit_slug', key: { slug: 1 }, document: { name: 'REGULAR', slug: 'regular' } },
      { Model: Fabric, indexName: 'unique_fabric_slug', key: { slug: 1 }, document: { name: 'COTTON', slug: 'cotton' } },
    ];

    for (const fixture of fixtures) {
      await fixture.Model.collection.insertOne(fixture.document);
      await fixture.Model.collection.createIndex(fixture.key, { unique: true, name: fixture.indexName });
    }

    const dryRun = await inspectCatalogSlugs();
    assert.equal(dryRun.length, fixtures.length);
    assert.ok(dryRun.every((entry) => entry.documentsWithSlug === 1 && entry.expectedIndexPresent));
    assert.equal(await Category.collection.countDocuments({ slug: { $exists: true } }), 1);

    const applied = await removeCatalogSlugs();
    assert.ok(applied.every((entry) => entry.documentsUpdated === 1 && entry.indexDropped));
    const after = await inspectCatalogSlugs();
    assert.ok(after.every((entry) => entry.documentsWithSlug === 0 && !entry.expectedIndexPresent));

    const repeated = await removeCatalogSlugs();
    assert.ok(repeated.every((entry) => entry.documentsUpdated === 0 && !entry.indexDropped));
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
