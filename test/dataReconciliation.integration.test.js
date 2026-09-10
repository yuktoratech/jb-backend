const assert = require('node:assert/strict');
const { test } = require('node:test');
const mongoose = require('mongoose');

const Category = require('../src/modules/categories/category.model');
const Colour = require('../src/modules/colours/colour.model');
const Fabric = require('../src/modules/fabrics/fabric.model');
const Fit = require('../src/modules/fits/fit.model');
const Inventory = require('../src/modules/inventory/inventory.model');
const Product = require('../src/modules/products/product.model');
const ProductColour = require('../src/modules/productColours/productColour.model');
const SizeSet = require('../src/modules/sizeSets/sizeSet.model');
const SubCategory = require('../src/modules/subcategories/subCategory.model');
const ProductVariant = require('../src/modules/variants/productVariant.model');
const { reconcileLegacyData, rupeesToMinor } = require('../src/modules/dataReconciliation/dataReconciliation.service');

const URI = process.env.DATA_RECONCILIATION_TEST_MONGODB_URI;

test('legacy data reconciliation is safe and idempotent', { timeout: 90000, skip: !URI && 'DATA_RECONCILIATION_TEST_MONGODB_URI replica-set URI is required' }, async (t) => {
  await mongoose.connect(URI);
  try {
    await mongoose.connection.dropDatabase();

    await t.test('exact decimal rupees become integer paise', () => {
      assert.equal(rupeesToMinor('1000'), 100000);
      assert.equal(rupeesToMinor('1299.50'), 129950);
      assert.equal(rupeesToMinor(12.05), 1205);
      assert.throws(() => rupeesToMinor('1.005'));
    });

    const category = await Category.create({ name: 'Jeans', status: 'active' });
    const subCategory = await SubCategory.create({ name: 'Denim', category: category._id, status: 'active' });
    await Promise.all([
      Fit.create({ name: 'Regular', status: 'active' }),
      Fabric.create({ name: 'Cotton', status: 'active' }),
      SizeSet.create({ label: '32-36', sizes: ['32', '34', '36'], status: 'active' }),
    ]);

    const productId = new mongoose.Types.ObjectId();
    const variantId = new mongoose.Types.ObjectId();
    const inventoryId = new mongoose.Types.ObjectId();
    await Product.collection.insertOne({
      _id: productId, productName: 'Legacy Denim', title: 'Old title', productCode: ' DENIM BLACK ',
      category: category._id, subCategory: subCategory._id, fit: 'Regular', fabric: 'Cotton', mrp: '1299.50',
      images: ['legacy/image.jpg'], status: 'active', createdAt: new Date(), updatedAt: new Date(),
    });
    await ProductVariant.collection.insertOne({
      _id: variantId, product: productId, color: 'Black', sizeSet: '32-36', sku: 'DENIM BLACK 32-36',
      sourceProductCode: ' DENIM BLACK ', status: 'active', createdAt: new Date(), updatedAt: new Date(),
    });
    await Inventory.collection.insertOne({
      _id: inventoryId, variant: variantId, sku: 'DENIM BLACK 32-36',
      shelves: [{ shelf: 'A', quantity: 9 }], availableQuantity: 9, totalQuantity: 9,
      reservedQuantity: 4, reservedShelves: [{ shelf: 'A', quantity: 4 }], status: 'in_stock',
    });
    const legacyLedgerId = new mongoose.Types.ObjectId();
    await mongoose.connection.db.collection('inventorytransactions').insertOne({
      _id: legacyLedgerId, inventory: inventoryId, variant: variantId, sku: 'DENIM BLACK 32-36',
      type: 'ORDER_RESERVE', quantity: 4, source: 'order', createdAt: new Date(),
    });
    const rejectedOrderId = new mongoose.Types.ObjectId();
    const ambiguousOrderId = new mongoose.Types.ObjectId();
    await mongoose.connection.db.collection('orders').insertMany([
      { _id: rejectedOrderId, status: 'REJECTED', history: [{ previousStatus: 'PENDING_ADMIN', newStatus: 'REJECTED' }], items: [{ piecesPerSet: 3, mrpPerPieceMinor: 129950 }], grossAmountMinor: 389850, discountAmountMinor: 0, taxableAmountMinor: 389850, gstPercent: 5, gstAmountMinor: 19493, finalAmountMinor: 409343 },
      { _id: ambiguousOrderId, status: 'CONFIRMED', items: [{ mrp: 1299.5 }], total: 1299.5 },
    ]);
    await mongoose.connection.db.collection('users').insertOne({ _id: new mongoose.Types.ObjectId(), name: 'Missing Phone', email: 'missing@example.test', password: 'legacy', role: 'wholesaler', status: 'active' });

    const before = {
      products: await Product.collection.find({}).toArray(),
      variants: await ProductVariant.collection.find({}).toArray(),
      inventories: await Inventory.collection.find({}).toArray(),
      colours: await Colour.collection.find({}).toArray(),
      orders: await mongoose.connection.db.collection('orders').find({}).toArray(),
    };
    const dryRun = await reconcileLegacyData();
    assert.equal(dryRun.mode, 'dry-run');
    assert.equal(dryRun.canApply, true);
    assert(dryRun.issues.some(({ code }) => code === 'MISSING_MANDATORY_PHONE'));
    assert(dryRun.issues.some(({ code }) => code === 'MANUAL_IMAGE_ASSIGNMENT_REQUIRED'));
    assert(dryRun.issues.some(({ code }) => code === 'INCOMPATIBLE_LEGACY_ORDER_PRICING'));
    assert.deepEqual(await Product.collection.find({}).toArray(), before.products);
    assert.deepEqual(await ProductVariant.collection.find({}).toArray(), before.variants);
    assert.deepEqual(await Inventory.collection.find({}).toArray(), before.inventories);
    assert.deepEqual(await Colour.collection.find({}).toArray(), before.colours);
    assert.deepEqual(await mongoose.connection.db.collection('orders').find({}).toArray(), before.orders);

    const applied = await reconcileLegacyData({ apply: true });
    assert.equal(applied.mode, 'apply');
    const product = await Product.collection.findOne({ _id: productId });
    const variant = await ProductVariant.collection.findOne({ _id: variantId });
    const inventory = await Inventory.collection.findOne({ _id: inventoryId });
    const productColour = await ProductColour.collection.findOne({ product: productId });
    assert.equal(product.catalogVersion, 2);
    assert.equal(product.mrpPerPieceMinor, 129950);
    assert.equal(product.productName, 'Legacy Denim');
    assert.deepEqual(product.images, ['legacy/image.jpg']);
    assert.equal(variant._id.toString(), variantId.toString());
    assert.equal(variant.catalogVersion, 2);
    assert.equal(variant.sku, 'DENIM_BLACK_32-36');
    assert.equal(variant.productColour.toString(), productColour._id.toString());
    assert.equal(inventory.variant.toString(), variantId.toString());
    assert.equal(inventory.sku, 'DENIM_BLACK_32-36');
    assert.equal(inventory.shelves[0].quantity, 9);
    assert.equal(inventory.reservedQuantity, undefined);
    assert.equal(inventory.reservedShelves, undefined);
    assert.equal((await mongoose.connection.db.collection('inventorytransactions').findOne({ _id: legacyLedgerId })).legacyReservationEntry, true);
    assert.equal((await mongoose.connection.db.collection('orders').findOne({ _id: rejectedOrderId })).status, 'CANCELLED');
    assert.equal((await mongoose.connection.db.collection('orders').findOne({ _id: ambiguousOrderId })).total, 1299.5);

    const rerun = await reconcileLegacyData({ apply: true });
    assert.equal(rerun.areas.catalog.migrated, 0);
    assert.equal(rerun.areas.inventory.migrated, 0);
    assert.equal(rerun.areas.orders.migrated, 0);

    await t.test('SKU collisions and unknown SizeSets block every write', async () => {
      await ProductVariant.collection.insertMany([
        { _id: new mongoose.Types.ObjectId(), product: productId, color: 'Blue', sizeSet: 'UNKNOWN', sku: 'COLLIDE', sourceProductCode: 'denim_blue', status: 'active' },
        { _id: new mongoose.Types.ObjectId(), product: productId, color: 'Red', sizeSet: '32-36', sku: 'collide', sourceProductCode: 'denim_red', status: 'active' },
      ]);
      const countBefore = await Colour.countDocuments();
      const blocked = await reconcileLegacyData();
      assert.equal(blocked.canApply, false);
      assert(blocked.issues.some(({ code }) => code === 'SKU_COLLISION'));
      assert(blocked.issues.some(({ code }) => code === 'UNKNOWN_SIZE_SET'));
      await assert.rejects(() => reconcileLegacyData({ apply: true }), (error) => error.code === 'MIGRATION_BLOCKED');
      assert.equal(await Colour.countDocuments(), countBefore);
    });

    await t.test('ambiguous ProductColour and invalid inventory are reported', async () => {
      await ProductVariant.collection.deleteMany({ catalogVersion: { $ne: 2 } });
      await Inventory.collection.deleteOne({ variant: variantId });
      const anotherProduct = new mongoose.Types.ObjectId();
      await Product.collection.insertOne({ _id: anotherProduct, productName: 'Ambiguous', productCode: 'same_code', category: category._id, subCategory: subCategory._id, fit: 'Regular', fabric: 'Cotton', mrp: 100 });
      await ProductVariant.collection.insertMany([
        { _id: new mongoose.Types.ObjectId(), product: anotherProduct, color: 'Red', sizeSet: '32-36', sku: 'same_code_32-36', sourceProductCode: 'same_code' },
        { _id: new mongoose.Types.ObjectId(), product: anotherProduct, color: 'Blue', sizeSet: '32-36', sku: 'same_code_other', sourceProductCode: 'same_code' },
        { _id: new mongoose.Types.ObjectId(), product: productId, color: 'Black', sizeSet: '32-36', sku: 'denim_black_alternate', sourceProductCode: 'disagrees_with_existing' },
      ]);
      await Inventory.collection.insertMany([
        { _id: new mongoose.Types.ObjectId(), variant: new mongoose.Types.ObjectId(), sku: 'orphan', shelves: [], availableQuantity: 0, totalQuantity: 0, status: 'out_of_stock' },
        { _id: new mongoose.Types.ObjectId(), variant: variantId, sku: 'negative_fixture', shelves: [{ shelf: 'BAD', quantity: -1 }], availableQuantity: 0, totalQuantity: 0, status: 'out_of_stock' },
      ]);
      const report = await reconcileLegacyData();
      assert.equal(report.canApply, false);
      assert(report.issues.some(({ code }) => code === 'PRODUCT_CODE_COLLISION'));
      assert(report.issues.some(({ code }) => code === 'AMBIGUOUS_PRODUCT_COLOUR'));
      assert(report.issues.some(({ code }) => code === 'ORPHAN_INVENTORY_REFERENCE'));
      assert(report.issues.some(({ code }) => code === 'NEGATIVE_SHELF_QUANTITY'));
    });
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
