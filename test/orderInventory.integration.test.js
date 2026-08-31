const assert = require('node:assert/strict');
const { test } = require('node:test');

const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const TEST_DATABASE_URI =
  process.env.ORDER_INVENTORY_TEST_MONGODB_URI ||
  'mongodb://127.0.0.1:27017/jb_b2b_order_inventory_test';
const databaseName = new URL(TEST_DATABASE_URI).pathname.slice(1);

if (!/^jb_b2b_order_inventory_test(?:_|$)/.test(databaseName)) {
  throw new Error(
    'ORDER_INVENTORY_TEST_MONGODB_URI must target a jb_b2b_order_inventory_test database',
  );
}

const Inventory = require('../src/modules/inventory/inventory.model');
const inventoryService = require('../src/modules/inventory/inventory.service');
const InventoryTransaction = require('../src/modules/inventory/inventoryTransaction.model');
const ProductVariant = require('../src/modules/variants/productVariant.model');

const toShelfValues = (values) =>
  values.map(({ shelf, quantity }) => ({ shelf, quantity }));

const createStockedVariant = async ({ label, shelves }) => {
  const variant = await ProductVariant.create({
    product: new mongoose.Types.ObjectId(),
    color: `COLOR_${label}`,
    sizeSet: `SIZE_${label}`,
    sku: `ORDER_INV_${label}`,
    status: 'active',
  });
  const inventory = await Inventory.create({
    variant: variant._id,
    sku: variant.sku,
    shelves,
  });

  return { inventory, variant };
};

const clearCollections = async () => {
  await Promise.all([
    InventoryTransaction.deleteMany({}),
    Inventory.deleteMany({}),
    ProductVariant.deleteMany({}),
  ]);
};

test(
  'order inventory operations preserve shelf allocations and stock invariants',
  { timeout: 60000 },
  async (t) => {
    try {
      await mongoose.connect(TEST_DATABASE_URI);
      await mongoose.connection.dropDatabase();
      await Promise.all([
        ProductVariant.init(),
        Inventory.init(),
        InventoryTransaction.init(),
      ]);

      await t.test(
        'reserves in shelf insertion order, releases, and deducts exact allocations',
        async () => {
          await clearCollections();
          const { variant } = await createStockedVariant({
            label: 'FIFO',
            shelves: [
              { shelf: 'A1', quantity: 3 },
              { shelf: 'B2', quantity: 5 },
            ],
          });
          const line = {
            variantId: variant._id,
            sku: variant.sku,
            quantity: 6,
          };

          const reserved = await inventoryService.reserveOrderStock([line], {
            referenceId: 'ORDER-FIFO-RESERVE',
          });
          const allocation = reserved.result[0].inventoryAllocation;

          assert.deepEqual(toShelfValues(allocation), [
            { shelf: 'A1', quantity: 3 },
            { shelf: 'B2', quantity: 3 },
          ]);

          let inventory = await Inventory.findOne({
            variant: variant._id,
          }).lean();
          assert.deepEqual(toShelfValues(inventory.shelves), [
            { shelf: 'A1', quantity: 3 },
            { shelf: 'B2', quantity: 5 },
          ]);
          assert.deepEqual(toShelfValues(inventory.reservedShelves), [
            { shelf: 'A1', quantity: 3 },
            { shelf: 'B2', quantity: 3 },
          ]);
          assert.equal(inventory.totalQuantity, 8);
          assert.equal(inventory.reservedQuantity, 6);
          assert.equal(inventory.availableQuantity, 2);

          await inventoryService.releaseOrderStock(
            [{ ...line, inventoryAllocation: allocation }],
            { referenceId: 'ORDER-FIFO-RELEASE' },
          );

          inventory = await Inventory.findOne({ variant: variant._id }).lean();
          assert.deepEqual(inventory.reservedShelves, []);
          assert.equal(inventory.totalQuantity, 8);
          assert.equal(inventory.reservedQuantity, 0);
          assert.equal(inventory.availableQuantity, 8);

          const reservedAgain = await inventoryService.reserveOrderStock(
            [line],
            { referenceId: 'ORDER-FIFO-RESERVE-AGAIN' },
          );
          const finalAllocation =
            reservedAgain.result[0].inventoryAllocation;

          await inventoryService.finalizeOrderStock(
            [{ ...line, inventoryAllocation: finalAllocation }],
            { referenceId: 'ORDER-FIFO-DEDUCT' },
          );

          inventory = await Inventory.findOne({ variant: variant._id }).lean();
          assert.deepEqual(toShelfValues(inventory.shelves), [
            { shelf: 'B2', quantity: 2 },
          ]);
          assert.deepEqual(inventory.reservedShelves, []);
          assert.equal(inventory.totalQuantity, 2);
          assert.equal(inventory.reservedQuantity, 0);
          assert.equal(inventory.availableQuantity, 2);

          const transactions = await InventoryTransaction.find({
            variant: variant._id,
          })
            .sort({ createdAt: 1, _id: 1 })
            .lean();
          assert.deepEqual(
            transactions.map(
              ({
                type,
                quantity,
                fromShelf,
                toShelf,
                previousQuantity,
                newQuantity,
              }) => ({
                type,
                quantity,
                fromShelf: fromShelf || null,
                toShelf: toShelf || null,
                previousQuantity,
                newQuantity,
              }),
            ),
            [
              {
                type: 'ORDER_RESERVE',
                quantity: 3,
                fromShelf: 'A1',
                toShelf: null,
                previousQuantity: 8,
                newQuantity: 2,
              },
              {
                type: 'ORDER_RESERVE',
                quantity: 3,
                fromShelf: 'B2',
                toShelf: null,
                previousQuantity: 8,
                newQuantity: 2,
              },
              {
                type: 'ORDER_RELEASE',
                quantity: 3,
                fromShelf: null,
                toShelf: 'A1',
                previousQuantity: 2,
                newQuantity: 8,
              },
              {
                type: 'ORDER_RELEASE',
                quantity: 3,
                fromShelf: null,
                toShelf: 'B2',
                previousQuantity: 2,
                newQuantity: 8,
              },
              {
                type: 'ORDER_RESERVE',
                quantity: 3,
                fromShelf: 'A1',
                toShelf: null,
                previousQuantity: 8,
                newQuantity: 2,
              },
              {
                type: 'ORDER_RESERVE',
                quantity: 3,
                fromShelf: 'B2',
                toShelf: null,
                previousQuantity: 8,
                newQuantity: 2,
              },
              {
                type: 'ORDER_DEDUCT',
                quantity: 3,
                fromShelf: 'A1',
                toShelf: null,
                previousQuantity: 2,
                newQuantity: 2,
              },
              {
                type: 'ORDER_DEDUCT',
                quantity: 3,
                fromShelf: 'B2',
                toShelf: null,
                previousQuantity: 2,
                newQuantity: 2,
              },
            ],
          );
          assert.ok(
            transactions.every((transaction) => transaction.source === 'order'),
          );
        },
      );

      await t.test(
        'protects reserved shelf stock from manual remove and transfer',
        async () => {
          await clearCollections();
          const { variant } = await createStockedVariant({
            label: 'PROTECT',
            shelves: [
              { shelf: 'A1', quantity: 5 },
              { shelf: 'B2', quantity: 5 },
            ],
          });

          await inventoryService.reserveOrderStock(
            [
              {
                variantId: variant._id,
                sku: variant.sku,
                quantity: 4,
              },
            ],
            { referenceId: 'ORDER-PROTECT-RESERVE' },
          );

          const assertProtected = async (adjustment) => {
            await assert.rejects(
              () =>
                inventoryService.adjustInventory({
                  sku: variant.sku,
                  quantity: 2,
                  shelf: 'A1',
                  ...adjustment,
                }),
              (error) => {
                assert.equal(error.statusCode, 409);
                assert.match(error.message, /unreserved stock/i);
                return true;
              },
            );
          };

          await assertProtected({ type: 'REMOVE' });
          await assertProtected({ type: 'TRANSFER', toShelf: 'B2' });

          const inventory = await Inventory.findOne({
            variant: variant._id,
          }).lean();
          assert.deepEqual(toShelfValues(inventory.shelves), [
            { shelf: 'A1', quantity: 5 },
            { shelf: 'B2', quantity: 5 },
          ]);
          assert.deepEqual(toShelfValues(inventory.reservedShelves), [
            { shelf: 'A1', quantity: 4 },
          ]);
          assert.equal(inventory.availableQuantity, 6);
        },
      );

      await t.test(
        'does not leave partial reservations when a multi-line reservation fails',
        async () => {
          await clearCollections();
          const [{ variant: first }, { variant: second }] = await Promise.all([
            createStockedVariant({
              label: 'ATOMIC_A',
              shelves: [{ shelf: 'A1', quantity: 5 }],
            }),
            createStockedVariant({
              label: 'ATOMIC_B',
              shelves: [{ shelf: 'B2', quantity: 2 }],
            }),
          ]);

          await assert.rejects(
            () =>
              inventoryService.reserveOrderStock(
                [
                  { variantId: first._id, sku: first.sku, quantity: 4 },
                  { variantId: second._id, sku: second.sku, quantity: 3 },
                ],
                { referenceId: 'ORDER-ATOMIC-INSUFFICIENT' },
              ),
            (error) => {
              assert.equal(error.statusCode, 409);
              assert.match(error.message, /insufficient stock/i);
              return true;
            },
          );

          let inventories = await Inventory.find({})
            .sort({ sku: 1 })
            .lean();
          assert.deepEqual(
            inventories.map((inventory) => ({
              availableQuantity: inventory.availableQuantity,
              reservedQuantity: inventory.reservedQuantity,
              reservedShelves: inventory.reservedShelves,
            })),
            [
              { availableQuantity: 5, reservedQuantity: 0, reservedShelves: [] },
              { availableQuantity: 2, reservedQuantity: 0, reservedShelves: [] },
            ],
          );
          assert.equal(await InventoryTransaction.countDocuments(), 0);

          const secondInventory = await Inventory.findOne({
            variant: second._id,
          });
          secondInventory.shelves = [{ shelf: 'B2', quantity: 5 }];
          await secondInventory.save();

          await assert.rejects(
            () =>
              inventoryService.reserveOrderStock(
                [
                  { variantId: first._id, sku: first.sku, quantity: 4 },
                  { variantId: second._id, sku: second.sku, quantity: 3 },
                ],
                { referenceId: 'ORDER-ATOMIC-COMMIT-FAILURE' },
                async () => {
                  throw new Error('Simulated order commit failure');
                },
              ),
            /Simulated order commit failure/,
          );

          inventories = await Inventory.find({}).sort({ sku: 1 }).lean();
          assert.deepEqual(
            inventories.map((inventory) => ({
              availableQuantity: inventory.availableQuantity,
              reservedQuantity: inventory.reservedQuantity,
              reservedShelves: inventory.reservedShelves,
            })),
            [
              { availableQuantity: 5, reservedQuantity: 0, reservedShelves: [] },
              { availableQuantity: 5, reservedQuantity: 0, reservedShelves: [] },
            ],
          );
          assert.equal(await InventoryTransaction.countDocuments(), 0);
        },
      );

      await t.test(
        'retains audit history for inventory that cannot be compensated',
        async () => {
          await clearCollections();
          const [{ variant: first }, { variant: second }] = await Promise.all([
            createStockedVariant({
              label: 'ROLLBACK_A',
              shelves: [{ shelf: 'A1', quantity: 5 }],
            }),
            createStockedVariant({
              label: 'ROLLBACK_B',
              shelves: [{ shelf: 'B2', quantity: 5 }],
            }),
          ]);
          let criticalLog;
          const originalConsoleError = console.error;
          console.error = (...values) => {
            criticalLog = values.join(' ');
          };

          try {
            await assert.rejects(
              () =>
                inventoryService.reserveOrderStock(
                  [
                    { variantId: first._id, sku: first.sku, quantity: 2 },
                    { variantId: second._id, sku: second.sku, quantity: 2 },
                  ],
                  { referenceId: 'ORDER-ROLLBACK-PARTIAL' },
                  async () => {
                    await Inventory.updateOne(
                      { variant: first._id },
                      { $inc: { __v: 1 } },
                    );
                    throw new Error('Simulated concurrent inventory write');
                  },
                ),
              (error) => {
                assert.equal(error.statusCode, 500);
                assert.match(error.message, /administrator review/i);
                return true;
              },
            );
          } finally {
            console.error = originalConsoleError;
          }

          assert.match(criticalLog, /needs reconciliation/i);

          const [firstInventory, secondInventory] = await Promise.all([
            Inventory.findOne({ variant: first._id }).lean(),
            Inventory.findOne({ variant: second._id }).lean(),
          ]);
          assert.equal(firstInventory.reservedQuantity, 2);
          assert.equal(firstInventory.availableQuantity, 3);
          assert.equal(secondInventory.reservedQuantity, 0);
          assert.equal(secondInventory.availableQuantity, 5);

          const retainedTransactions = await InventoryTransaction.find({
            referenceId: 'ORDER-ROLLBACK-PARTIAL',
          }).lean();
          assert.equal(retainedTransactions.length, 1);
          assert.equal(retainedTransactions[0].variant.toString(), first._id.toString());
          assert.equal(retainedTransactions[0].type, 'ORDER_RESERVE');
        },
      );

      await t.test(
        'allows exactly one of two simultaneous quantity-four reservations against stock five',
        async () => {
          await clearCollections();
          const { variant } = await createStockedVariant({
            label: 'CONCURRENT',
            shelves: [{ shelf: 'A1', quantity: 5 }],
          });
          const line = {
            variantId: variant._id,
            sku: variant.sku,
            quantity: 4,
          };

          const outcomes = await Promise.allSettled([
            inventoryService.reserveOrderStock([line], {
              referenceId: 'ORDER-CONCURRENT-A',
            }),
            inventoryService.reserveOrderStock([line], {
              referenceId: 'ORDER-CONCURRENT-B',
            }),
          ]);
          const fulfilled = outcomes.filter(
            ({ status }) => status === 'fulfilled',
          );
          const rejected = outcomes.filter(
            ({ status }) => status === 'rejected',
          );

          assert.equal(fulfilled.length, 1);
          assert.equal(rejected.length, 1);
          assert.equal(rejected[0].reason.statusCode, 409);
          assert.match(rejected[0].reason.message, /insufficient stock/i);

          const inventory = await Inventory.findOne({
            variant: variant._id,
          }).lean();
          assert.deepEqual(toShelfValues(inventory.shelves), [
            { shelf: 'A1', quantity: 5 },
          ]);
          assert.deepEqual(toShelfValues(inventory.reservedShelves), [
            { shelf: 'A1', quantity: 4 },
          ]);
          assert.equal(inventory.totalQuantity, 5);
          assert.equal(inventory.reservedQuantity, 4);
          assert.equal(inventory.availableQuantity, 1);
          assert.equal(
            await InventoryTransaction.countDocuments({
              variant: variant._id,
              type: 'ORDER_RESERVE',
            }),
            1,
          );
        },
      );
    } finally {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.connection.dropDatabase();
        await mongoose.disconnect();
      }
    }
  },
);
