const mongoose = require('mongoose');
const { normalizeProductCode, normalizeProductName, normalizeSku, normalizeUpperText } = require('../../utils/sku');

const id = (value) => value.toString();
const collisionEntries = (records, valueOf) => {
  const buckets = new Map();
  records.forEach((record) => { const value = valueOf(record); if (!buckets.has(value)) buckets.set(value, []); buckets.get(value).push(id(record._id)); });
  return [...buckets.entries()].filter(([, ids]) => ids.length > 1).map(([value, ids]) => ({ value, ids }));
};
const buildUppercaseCatalogPlan = async ({ categorySizeFamilies = {} } = {}) => {
  const db = mongoose.connection.db;
  const [products, colours, sizeSets, productColours, variants, inventories, transactions, productBatches, inventoryBatches, categories] = await Promise.all([
    db.collection('products').find({ catalogVersion: 2 }).toArray(), db.collection('colours').find({}).toArray(), db.collection('sizesets').find({}).toArray(),
    db.collection('productcolours').find({}).toArray(), db.collection('productvariants').find({ catalogVersion: 2 }).toArray(), db.collection('inventories').find({}).toArray(),
    db.collection('inventorytransactions').find({}).toArray(), db.collection('productimportbatches').find({ status: { $ne: 'APPLIED' } }).toArray(),
    db.collection('importbatches').find({ status: { $ne: 'APPLIED' } }).toArray(), db.collection('categories').find({}).toArray(),
  ]);
  const issues = []; const updates = { products: [], colours: [], sizeSets: [], productColours: [], variants: [], inventories: [], transactions: [], categories: [] };
  products.forEach((record) => { try { const name = normalizeProductName(record.name); if (name !== record.name) updates.products.push({ _id: record._id, value: name }); } catch (error) { issues.push({ code: 'INVALID_PRODUCT_NAME', id: id(record._id), message: error.message }); } });
  colours.forEach((record) => { const name = normalizeUpperText(record.name, 'Colour'); if (name !== record.name) updates.colours.push({ _id: record._id, value: name }); });
  sizeSets.forEach((record) => { const label = normalizeUpperText(record.label, 'SizeSet label'); const sizes = record.sizes.map((size) => normalizeUpperText(size, 'Size')); if (label !== record.label || sizes.some((size, index) => size !== record.sizes[index])) updates.sizeSets.push({ _id: record._id, label, sizes }); });
  productColours.forEach((record) => { const value = normalizeProductCode(record.productCode); if (value !== record.productCode) updates.productColours.push({ _id: record._id, value }); });
  variants.forEach((record) => { const value = normalizeSku(record.sku); if (value !== record.sku) updates.variants.push({ _id: record._id, value }); });
  inventories.forEach((record) => { const value = normalizeSku(record.sku); if (value !== record.sku) updates.inventories.push({ _id: record._id, value }); });
  transactions.forEach((record) => { const value = normalizeSku(record.sku); if (value !== record.sku) updates.transactions.push({ _id: record._id, value }); });
  categories.forEach((record) => {
    const configured = record.sizeFamily || categorySizeFamilies[id(record._id)];
    if (!['ALPHA', 'NUMERIC'].includes(configured)) issues.push({ code: 'CATEGORY_SIZE_FAMILY_REQUIRED', id: id(record._id), message: `Category ${record.name} requires an explicit ALPHA or NUMERIC size family.` });
    else if (configured !== record.sizeFamily) updates.categories.push({ _id: record._id, value: configured });
  });
  collisionEntries(products.filter((record) => { try { normalizeProductName(record.name); return true; } catch (_) { return false; } }), (record) => normalizeProductName(record.name)).forEach((collision) => issues.push({ code: 'PRODUCT_NAME_COLLISION', ...collision }));
  collisionEntries(colours, (record) => normalizeUpperText(record.name, 'Colour')).forEach((collision) => issues.push({ code: 'COLOUR_COLLISION', ...collision }));
  collisionEntries(sizeSets, (record) => normalizeUpperText(record.label, 'SizeSet label')).forEach((collision) => issues.push({ code: 'SIZE_SET_COLLISION', ...collision }));
  collisionEntries(productColours, (record) => normalizeProductCode(record.productCode)).forEach((collision) => issues.push({ code: 'PRODUCT_CODE_COLLISION', ...collision }));
  collisionEntries(variants, (record) => normalizeSku(record.sku)).forEach((collision) => issues.push({ code: 'SKU_COLLISION', ...collision }));
  if (productBatches.length || inventoryBatches.length) issues.push({ code: 'ACTIVE_IMPORT_BATCHES', message: 'Unapplied import previews exist. Apply or let them expire, then run the migration again.', productBatchCount: productBatches.length, inventoryBatchCount: inventoryBatches.length });
  return { mode: 'DRY_RUN', safeToApply: issues.length === 0, issues, counts: Object.fromEntries(Object.entries(updates).map(([name, values]) => [name, values.length])), updates };
};
const applyUppercaseCatalogMigration = async ({ categorySizeFamilies = {}, afterWrites } = {}) => {
  const plan = await buildUppercaseCatalogPlan({ categorySizeFamilies });
  if (!plan.safeToApply) { const error = new Error('Uppercase catalog migration is blocked by audit issues.'); error.code = 'MIGRATION_BLOCKED'; error.report = { ...plan, updates: undefined }; throw error; }
  const db = mongoose.connection.db; const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const write = async (collection, rows, updateOf) => { for (const row of rows) await db.collection(collection).updateOne({ _id: row._id }, { $set: updateOf(row) }, { session }); };
      await write('products', plan.updates.products, (row) => ({ name: row.value }));
      await write('colours', plan.updates.colours, (row) => ({ name: row.value }));
      await write('sizesets', plan.updates.sizeSets, (row) => ({ label: row.label, sizes: row.sizes, pieceCount: row.sizes.length }));
      await write('productcolours', plan.updates.productColours, (row) => ({ productCode: row.value }));
      await write('productvariants', plan.updates.variants, (row) => ({ sku: row.value }));
      await write('inventories', plan.updates.inventories, (row) => ({ sku: row.value }));
      await write('inventorytransactions', plan.updates.transactions, (row) => ({ sku: row.value }));
      await write('categories', plan.updates.categories, (row) => ({ sizeFamily: row.value }));
      if (afterWrites) await afterWrites({ session, plan });
    });
    return { mode: 'APPLY', applied: true, counts: plan.counts, issues: [] };
  } finally { await session.endSession(); }
};
module.exports = { applyUppercaseCatalogMigration, buildUppercaseCatalogPlan };
