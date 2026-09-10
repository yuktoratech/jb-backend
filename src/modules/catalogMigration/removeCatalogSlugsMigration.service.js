const Category = require('../categories/category.model');
const SubCategory = require('../subcategories/subCategory.model');
const Colour = require('../colours/colour.model');
const Fit = require('../fits/fit.model');
const Fabric = require('../fabrics/fabric.model');

const targets = [
  { Model: Category, indexName: 'unique_category_slug' },
  { Model: SubCategory, indexName: 'unique_subcategory_slug_per_category' },
  { Model: Colour, indexName: 'unique_colour_slug' },
  { Model: Fit, indexName: 'unique_fit_slug' },
  { Model: Fabric, indexName: 'unique_fabric_slug' },
];

const hasSlugKey = (index) => Object.prototype.hasOwnProperty.call(index.key || {}, 'slug');

const inspectCatalogSlugs = async () => Promise.all(targets.map(async ({ Model, indexName }) => {
  const indexes = await Model.collection.listIndexes().toArray();
  const slugIndexes = indexes.filter(hasSlugKey);
  return {
    collection: Model.collection.collectionName,
    documentsWithSlug: await Model.collection.countDocuments({ slug: { $exists: true } }),
    expectedIndexPresent: slugIndexes.some((index) => index.name === indexName),
    unexpectedSlugIndexes: slugIndexes.filter((index) => index.name !== indexName).map((index) => index.name),
  };
}));

const removeCatalogSlugs = async () => {
  const before = await inspectCatalogSlugs();
  const unexpected = before.flatMap(({ collection, unexpectedSlugIndexes }) =>
    unexpectedSlugIndexes.map((indexName) => ({ collection, indexName })));
  if (unexpected.length) {
    throw new Error(`Unexpected slug indexes found: ${unexpected.map(({ collection, indexName }) => `${collection}.${indexName}`).join(', ')}`);
  }

  const results = [];
  for (const target of targets) {
    const snapshot = before.find(({ collection }) => collection === target.Model.collection.collectionName);
    if (snapshot.expectedIndexPresent) await target.Model.collection.dropIndex(target.indexName);
    const update = await target.Model.collection.updateMany(
      { slug: { $exists: true } },
      { $unset: { slug: '' } },
    );
    results.push({
      collection: snapshot.collection,
      indexDropped: snapshot.expectedIndexPresent,
      documentsUpdated: update.modifiedCount,
    });
  }
  return results;
};

module.exports = { inspectCatalogSlugs, removeCatalogSlugs };
