const assert = require('node:assert/strict');
const { test } = require('node:test');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
const URI = process.env.ORDER_INVENTORY_TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/jb_b2b_order_inventory_test';
if (!/^jb_b2b_order_inventory_test(?:_|$)/.test(new URL(URI).pathname.slice(1))) throw new Error('ORDER_INVENTORY_TEST_MONGODB_URI must target a safe test database');

const Inventory = require('../src/modules/inventory/inventory.model');
const inventoryService = require('../src/modules/inventory/inventory.service');
const InventoryTransaction = require('../src/modules/inventory/inventoryTransaction.model');
const { allocateShelfStock } = require('../src/modules/inventory/shelfAllocation');
const ProductVariant = require('../src/modules/variants/productVariant.model');

const createStock = async (label, shelves) => {
  const variant = await ProductVariant.create({ product: new mongoose.Types.ObjectId(), color: `COLOR_${label}`, sizeSet: `SIZE_${label}`, sku: `foundation_${label}`, status: 'active' });
  const inventory = await Inventory.create({ variant: variant._id, sku: variant.sku, shelves });
  return { inventory, variant };
};
const balances = (inventory) => inventory.shelves.map(({ shelf, quantity }) => ({ shelf, quantity })).sort((left, right) => left.shelf.localeCompare(right.shelf));

test('inventory foundation has no reservation behavior and allocates shelves deterministically', { timeout: 60000 }, async (t) => {
  assert.equal(Inventory.schema.path('reservedQuantity'), undefined);
  assert.equal(Inventory.schema.path('reservedShelves'), undefined);
  assert.equal(inventoryService.reserveOrderStock, undefined);
  assert.equal(inventoryService.releaseOrderStock, undefined);
  assert.equal(inventoryService.reconcileOrderStock, undefined);
  assert.equal(inventoryService.finalizeOrderStock, undefined);
  assert.equal(InventoryTransaction.schema.path('type').enumValues.includes('ORDER_RESERVE'), false);
  assert.equal(InventoryTransaction.schema.path('type').enumValues.includes('ORDER_RELEASE'), false);

  await t.test('exhausts B=5 before A=10 for demand 7', () => {
    const result = allocateShelfStock([{ shelf: 'A', quantity: 10 }, { shelf: 'B', quantity: 5 }], 7);
    assert.equal(result.sufficient, true);
    assert.deepEqual(result.allocations, [
      { shelf: 'B', quantity: 5, previousShelfQuantity: 5, newShelfQuantity: 0 },
      { shelf: 'A', quantity: 2, previousShelfQuantity: 10, newShelfQuantity: 8 },
    ]);
  });
  await t.test('uses shelf-code ordering when quantities are equal', () => {
    const result = allocateShelfStock([{ shelf: 'B2', quantity: 4 }, { shelf: 'A1', quantity: 4 }, { shelf: 'C3', quantity: 4 }], 6);
    assert.deepEqual(result.allocations.map(({ shelf, quantity }) => ({ shelf, quantity })), [{ shelf: 'A1', quantity: 4 }, { shelf: 'B2', quantity: 2 }]);
  });
  await t.test('reports insufficient aggregate stock without allocations', () => {
    assert.deepEqual(allocateShelfStock([{ shelf: 'A', quantity: 2 }], 3), { allocations: [], sufficient: false, totalAvailable: 2 });
  });

  try {
    await mongoose.connect(URI);
    await mongoose.connection.dropDatabase();
    await Promise.all([ProductVariant.init(), Inventory.init(), InventoryTransaction.init()]);

    await t.test('legacy reservation fields are ignored and physical shelves are authoritative', async () => {
      const { inventory } = await createStock('legacy', [{ shelf: 'A1', quantity: 5 }]);
      await Inventory.collection.updateOne({ _id: inventory._id }, { $set: { reservedQuantity: 5, reservedShelves: [{ shelf: 'A1', quantity: 5 }] } });
      const loaded = await Inventory.findById(inventory._id);
      loaded.shelves[0].quantity = 4;
      await loaded.save();
      const stored = await Inventory.collection.findOne({ _id: inventory._id });
      assert.equal(stored.availableQuantity, 4);
      assert.equal(stored.totalQuantity, 4);
    });

    await t.test('manual ADD, REMOVE, and TRANSFER remain ledgered and non-negative', async () => {
      await mongoose.connection.dropDatabase();
      const { variant } = await createStock('manual', []);
      await inventoryService.adjustInventory({ sku: variant.sku, type: 'ADD', quantity: 10, shelf: 'A' });
      await inventoryService.adjustInventory({ sku: variant.sku, type: 'TRANSFER', quantity: 5, shelf: 'A', toShelf: 'B' });
      await inventoryService.adjustInventory({ sku: variant.sku, type: 'REMOVE', quantity: 2, shelf: 'B' });
      await assert.rejects(inventoryService.adjustInventory({ sku: variant.sku, type: 'REMOVE', quantity: 4, shelf: 'B' }), /Insufficient stock/);
      const inventory = await Inventory.findOne({ variant: variant._id }).lean();
      assert.deepEqual(balances(inventory), [{ shelf: 'A', quantity: 5 }, { shelf: 'B', quantity: 3 }]);
      assert.equal(inventory.availableQuantity, 8);
      assert.equal(inventory.totalQuantity, 8);
      assert.deepEqual((await InventoryTransaction.find({ variant: variant._id }).sort({ createdAt: 1 }).lean()).map(({ type }) => type), ['ADD', 'TRANSFER', 'REMOVE']);
    });

    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    const transactionsSupported = Boolean(hello.setName || hello.msg === 'isdbgrid');
    const transactionOptions = { skip: !transactionsSupported && 'MongoDB is not transaction-capable' };

    await t.test('multi-shelf deduction and ledger writes use the caller transaction', transactionOptions, async () => {
      await mongoose.connection.dropDatabase();
      const { variant } = await createStock('deduct', [{ shelf: 'A', quantity: 10 }, { shelf: 'B', quantity: 5 }]);
      const session = await mongoose.startSession();
      session.startTransaction();
      const result = await inventoryService.deductSkuStock({ sku: variant.sku, quantity: 7, session, referenceId: 'ORDER-1' });
      assert.deepEqual(result.allocations, [{ shelf: 'B', quantity: 5 }, { shelf: 'A', quantity: 2 }]);
      await session.commitTransaction();
      await session.endSession();
      const inventory = await Inventory.findOne({ variant: variant._id }).lean();
      assert.deepEqual(balances(inventory), [{ shelf: 'A', quantity: 8 }]);
      assert.equal(await InventoryTransaction.countDocuments({ variant: variant._id, type: 'ORDER_DEDUCT' }), 2);
    });

    await t.test('insufficient stock aborts before writes', transactionOptions, async () => {
      await mongoose.connection.dropDatabase();
      const { variant } = await createStock('insufficient', [{ shelf: 'A', quantity: 2 }]);
      const session = await mongoose.startSession();
      session.startTransaction();
      await assert.rejects(inventoryService.deductSkuStock({ sku: variant.sku, quantity: 3, session }), /Insufficient stock/);
      await session.abortTransaction();
      await session.endSession();
      assert.equal((await Inventory.findOne({ variant: variant._id }).lean()).totalQuantity, 2);
      assert.equal(await InventoryTransaction.countDocuments({ variant: variant._id }), 0);
    });

    await t.test('caller abort rolls stock and ledger back together', transactionOptions, async () => {
      await mongoose.connection.dropDatabase();
      const { variant } = await createStock('rollback', [{ shelf: 'A', quantity: 6 }]);
      const session = await mongoose.startSession();
      session.startTransaction();
      await inventoryService.deductSkuStock({ sku: variant.sku, quantity: 4, session, referenceId: 'ROLLBACK' });
      await session.abortTransaction();
      await session.endSession();
      assert.equal((await Inventory.findOne({ variant: variant._id }).lean()).totalQuantity, 6);
      assert.equal(await InventoryTransaction.countDocuments({ variant: variant._id }), 0);
    });

    await t.test('only one competing deduction can consume stock five', transactionOptions, async () => {
      await mongoose.connection.dropDatabase();
      const { variant } = await createStock('race', [{ shelf: 'A', quantity: 5 }]);
      const deduct = async (referenceId) => {
        const session = await mongoose.startSession();
        try { return await session.withTransaction(() => inventoryService.deductSkuStock({ sku: variant.sku, quantity: 4, session, referenceId })); }
        finally { await session.endSession(); }
      };
      const results = await Promise.allSettled([deduct('RACE-1'), deduct('RACE-2')]);
      assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
      assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
      const inventory = await Inventory.findOne({ variant: variant._id }).lean();
      assert.equal(inventory.totalQuantity, 1);
      assert.ok(inventory.shelves.every(({ quantity }) => quantity >= 0));
      assert.equal(await InventoryTransaction.countDocuments({ variant: variant._id }), 1);
    });
  } finally {
    if (mongoose.connection.readyState) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
  }
});
