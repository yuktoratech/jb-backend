const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
const URI = process.env.INVENTORY_IMPORT_TEST_MONGODB_URI;
const Category = require('../src/modules/categories/category.model');
const Colour = require('../src/modules/colours/colour.model');
const Fabric = require('../src/modules/fabrics/fabric.model');
const Fit = require('../src/modules/fits/fit.model');
const ImportBatch = require('../src/modules/inventory/importBatch.model');
const Inventory = require('../src/modules/inventory/inventory.model');
const Ledger = require('../src/modules/inventory/inventoryTransaction.model');
const service = require('../src/modules/inventory/inventoryImport.service');
const Product = require('../src/modules/products/product.model');
const ProductColour = require('../src/modules/productColours/productColour.model');
const SizeSet = require('../src/modules/sizeSets/sizeSet.model');
const SubCategory = require('../src/modules/subcategories/subCategory.model');
const User = require('../src/modules/users/user.model');
const Variant = require('../src/modules/variants/productVariant.model');
const xlsx = require('./xlsxTestHelper');

const HEADERS = ['SKU', 'QTY', 'SHELF', 'ADJUSTMENT TYPE', 'TO SHELF'];
const workbook = (...rows) => xlsx([HEADERS, ...rows]);

test('Inventory Excel preview and atomic apply workflow', { timeout: 120000, skip: !URI && 'INVENTORY_IMPORT_TEST_MONGODB_URI replica-set URI is required' }, async (t) => {
  await mongoose.connect(URI);
  try {
    assert.ok((await mongoose.connection.db.admin().command({ hello: 1 })).setName);
    await mongoose.connection.dropDatabase();
    const admin = await User.create({ name: 'Import Admin', email: 'import@example.test', phone: '9000000001', password: 'Import-Test-1!', role: 'admin', status: 'active' });
    const category = await Category.create({ name: 'Import Category', sizeFamily: 'ALPHA', status: 'active' });
    const subCategory = await SubCategory.create({ category: category._id, name: 'Import Sub', status: 'active' });
    const [fit, fabric, black, blue, set] = await Promise.all([
      Fit.create({ name: 'Import Fit' }), Fabric.create({ name: 'Import Fabric' }),
      Colour.create({ name: 'Black' }), Colour.create({ name: 'Blue' }),
      SizeSet.create({ label: 'S-XL', sizes: ['S', 'M', 'L', 'XL'] }),
    ]);
    const product = await Product.create({ catalogVersion: 2, name: 'IMPORT', category: category._id, subCategory: subCategory._id, fitId: fit._id, fabricId: fabric._id, mrpPerPieceMinor: 10000 });
    const [blackPc, bluePc] = await ProductColour.create([
      { product: product._id, colour: black._id, productCode: 'import_black' },
      { product: product._id, colour: blue._id, productCode: 'import_blue' },
    ]);
    const blackSku = await Variant.create({ catalogVersion: 2, product: product._id, productColour: blackPc._id, sizeSetRef: set._id, sku: 'import_black_s-xl' });
    await Inventory.create({ variant: blackSku._id, sku: blackSku.sku, shelves: [{ shelf: 'A', quantity: 10 }] });
    const context = { performedBy: admin._id, originalName: 'stock.xlsx' };
    const preview = (buffer) => service.previewImport(buffer, context);
    const stock = async (variant = blackSku) => (await Inventory.findOne({ variant: variant._id }).lean()).shelves.map(({ shelf, quantity }) => ({ shelf, quantity }));

    await t.test('preview writes only ImportBatch and valid ADD applies with ledger', async () => {
      const before = await stock();
      const batch = await preview(workbook([blackSku.sku.toUpperCase(), 2, 'B', 'ADD', '']));
      assert.equal(batch.status, 'VALID'); assert.deepEqual(await stock(), before); assert.equal(await Ledger.countDocuments(), 0);
      await service.applyImport(batch.id, { performedBy: admin._id });
      assert.deepEqual(await stock(), [{ shelf: 'A', quantity: 10 }, { shelf: 'B', quantity: 2 }]);
      assert.equal(await Ledger.countDocuments({ type: 'ADD', referenceId: `IMPORT:${batch.id}` }), 1);
      assert.equal((await ImportBatch.findById(batch.id)).status, 'APPLIED');
      await assert.rejects(service.applyImport(batch.id, { performedBy: admin._id }), /already been applied/);
    });

    await t.test('REMOVE and TRANSFER revalidate and apply adjustments', async () => {
      const remove = await preview(workbook([blackSku.sku, 3, 'A', 'REMOVE', '']));
      await service.applyImport(remove.id, { performedBy: admin._id });
      const transfer = await preview(workbook([blackSku.sku, 2, 'A', 'TRANSFER', 'C']));
      await service.applyImport(transfer.id, { performedBy: admin._id });
      assert.deepEqual(await stock(), [{ shelf: 'A', quantity: 5 }, { shelf: 'B', quantity: 2 }, { shelf: 'C', quantity: 2 }]);
      assert.equal(await Ledger.countDocuments({ type: { $in: ['REMOVE', 'TRANSFER'] } }), 2);
    });

    await t.test('row and header validation rejects exact operations, bad quantities, shelves, and stock', async () => {
      const duplicate = await preview(workbook([blackSku.sku, 1, 'A', 'ADD', ''], [blackSku.sku.toUpperCase(), 1, 'A', 'add', '']));
      assert.equal(duplicate.status, 'INVALID'); assert.equal(duplicate.invalidRows, 2); assert.ok(duplicate.errors.every((e) => e.code === 'DUPLICATE_OPERATION'));
      const bad = await preview(workbook([blackSku.sku, 0, 'A', 'TRANSFER', 'A']));
      assert.equal(bad.status, 'INVALID'); assert.deepEqual(new Set(bad.errors.map((e) => e.code)), new Set(['INVALID_QUANTITY', 'SAME_SHELF']));
      const insufficient = await preview(workbook([blackSku.sku, 999, 'A', 'REMOVE', '']));
      assert.equal(insufficient.errors[0].code, 'INSUFFICIENT_STOCK');
      const missingHeader = await preview(xlsx([['SKU', 'QTY', 'SHELF', 'ADJUSTMENT TYPE'], [blackSku.sku, 1, 'A', 'ADD']]));
      assert.equal(missingHeader.errors[0].code, 'MISSING_COLUMN');
    });

    await t.test('repeated SKU operations use projected shelf balances and preserve workbook order', async () => {
      await Inventory.updateOne({ variant: blackSku._id }, { $set: { shelves: [], availableQuantity: 0, totalQuantity: 0 } });
      const batch = await preview(workbook(
        [blackSku.sku, 5, 'A1', 'ADD', ''],
        [blackSku.sku, 3, 'A1', 'TRANSFER', 'B1'],
        [blackSku.sku, 2, 'B1', 'REMOVE', ''],
        [blackSku.sku, 4, 'C1', 'ADD', ''],
        [blackSku.sku, 2, 'C1', 'ADD', ''],
        [blackSku.sku, 1, 'C1', 'TRANSFER', 'D1'],
        [blackSku.sku, 1, 'D1', 'REMOVE', ''],
      ));
      assert.equal(batch.status, 'VALID'); assert.equal(batch.validRows, 7); assert.equal(batch.invalidRows, 0);
      await service.applyImport(batch.id, { performedBy: admin._id });
      assert.deepEqual(await stock(), [{ shelf: 'A1', quantity: 2 }, { shelf: 'B1', quantity: 1 }, { shelf: 'C1', quantity: 5 }]);
      const operations = await Ledger.find({ referenceId: `IMPORT:${batch.id}` }).sort({ _id: 1 }).select('+operationKey').lean();
      assert.deepEqual(operations.map(({ type }) => type), ['ADD', 'TRANSFER', 'REMOVE', 'ADD', 'ADD', 'TRANSFER', 'REMOVE']);
      assert.deepEqual(operations.map(({ operationKey }) => operationKey), [2, 3, 4, 5, 6, 7, 8].map((rowNumber) => `IMPORT:${batch.id}:ROW:${rowNumber}`));
    });

    await t.test('later insufficient projected balance invalidates the whole batch', async () => {
      const before = await stock(); const ledgers = await Ledger.countDocuments();
      const batch = await preview(workbook([blackSku.sku, 1, 'Z1', 'ADD', ''], [blackSku.sku, 2, 'Z1', 'REMOVE', '']));
      assert.equal(batch.status, 'INVALID'); assert.equal(batch.validRows, 1); assert.equal(batch.invalidRows, 1);
      assert.equal(batch.errors[0].code, 'INSUFFICIENT_STOCK');
      await assert.rejects(service.applyImport(batch.id, { performedBy: admin._id }), /Only a valid preview batch/);
      assert.deepEqual(await stock(), before); assert.equal(await Ledger.countDocuments(), ledgers);
    });

    await t.test('stale stock blocks apply without partial writes', async () => {
      await Inventory.updateOne({ variant: blackSku._id }, { $set: { shelves: [{ shelf: 'A', quantity: 5 }], availableQuantity: 5, totalQuantity: 5 } });
      const batch = await preview(workbook([blackSku.sku, 5, 'A', 'REMOVE', '']));
      await Inventory.updateOne({ variant: blackSku._id }, { $set: { shelves: [{ shelf: 'A', quantity: 1 }], availableQuantity: 1, totalQuantity: 1 } });
      const beforeLedger = await Ledger.countDocuments();
      await assert.rejects(service.applyImport(batch.id, { performedBy: admin._id }), /Preview is stale/);
      assert.deepEqual(await stock(), [{ shelf: 'A', quantity: 1 }]); assert.equal(await Ledger.countDocuments(), beforeLedger);
      assert.equal((await ImportBatch.findById(batch.id)).status, 'VALID');
    });

    await t.test('later-row failure rolls back inventory, ledger, and batch', async () => {
      await Inventory.updateOne({ variant: blackSku._id }, { $set: { shelves: [{ shelf: 'A', quantity: 5 }], availableQuantity: 5, totalQuantity: 5 } });
      const blueVariant = await Variant.create({ catalogVersion: 2, product: product._id, productColour: bluePc._id, sizeSetRef: set._id, sku: 'import_blue_s-xl' });
      await Inventory.create({ variant: blueVariant._id, sku: blueVariant.sku, shelves: [] });
      const batch = await preview(workbook([blackSku.sku, 1, 'A', 'ADD', ''], [blueVariant.sku, 1, 'B', 'ADD', '']));
      const ledgers = await Ledger.countDocuments();
      await assert.rejects(service.applyImport(batch.id, { performedBy: admin._id, afterRowApplied: ({ index }) => { if (index === 1) throw new Error('injected later-row failure'); } }), /injected later-row failure/);
      assert.deepEqual(await stock(), [{ shelf: 'A', quantity: 5 }]); assert.deepEqual(await stock(blueVariant), []);
      assert.equal(await Ledger.countDocuments(), ledgers); assert.equal((await ImportBatch.findById(batch.id)).status, 'VALID');
    });

    await t.test('missing SKU creates a valid category-compatible SizeSet when needed', async () => {
      await Variant.deleteOne({ sku: 'import_blue_s-xl' }); await Inventory.deleteOne({ sku: 'import_blue_s-xl' });
      const counts = { products: await Product.countDocuments(), colours: await Colour.countDocuments() };
      const batch = await preview(workbook(['IMPORT BLUE S-XL', 4, 'Z', 'ADD', '']));
      assert.equal(batch.status, 'VALID'); assert.equal(batch.rows[0].resolution, 'CREATE_SKU');
      await service.applyImport(batch.id, { performedBy: admin._id });
      const created = await Variant.findOne({ sku: 'import_blue_s-xl' }); assert.ok(created);
      assert.deepEqual(await stock(created), [{ shelf: 'Z', quantity: 4 }]);
      assert.equal(await Product.countDocuments(), counts.products); assert.equal(await Colour.countDocuments(), counts.colours);
      const newSizeBatch = await preview(workbook(['IMPORT BLUE 2XL-3XL', 2, 'N', 'ADD', '']));
      assert.equal(newSizeBatch.status, 'VALID', JSON.stringify(newSizeBatch.errors));
      assert.equal(newSizeBatch.rows[0].createSizeSet, true);
      assert.equal(await SizeSet.countDocuments({ label: '2XL-3XL' }), 0, 'preview must not create the SizeSet');
      await service.applyImport(newSizeBatch.id, { performedBy: admin._id });
      const createdSet = await SizeSet.findOne({ label: '2XL-3XL' }).lean();
      const createdSizeSku = await Variant.findOne({ sku: 'IMPORT_BLUE_2XL-3XL' }).lean();
      assert.deepEqual(createdSet.sizes, ['2XL', '3XL']);
      assert.equal(createdSizeSku.sizeSetRef.toString(), createdSet._id.toString());
      assert.deepEqual(await stock(createdSizeSku), [{ shelf: 'N', quantity: 2 }]);
      const invalidFamily = await preview(workbook(['IMPORT BLUE 30-38', 1, 'A', 'ADD', '']));
      assert.equal(invalidFamily.status, 'INVALID');
      assert.match(invalidFamily.errors[0].message, /invalid for this alpha Category/);
      const unknown = await preview(workbook(['unknown_s-xl', 1, 'A', 'ADD', '']));
      assert.equal(unknown.status, 'INVALID'); assert.match(unknown.errors[0].message, /ProductColour could not be resolved/);
    });
  } finally { await mongoose.disconnect(); }
});
