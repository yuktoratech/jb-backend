const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.JWT_EXPIRES_IN = '1h';
const URI = process.env.ORDER_CONFIRMATION_TEST_MONGODB_URI;

const app = require('../src/app');
const Category = require('../src/modules/categories/category.model');
const Colour = require('../src/modules/colours/colour.model');
const Fabric = require('../src/modules/fabrics/fabric.model');
const Fit = require('../src/modules/fits/fit.model');
const Inventory = require('../src/modules/inventory/inventory.model');
const InventoryTransaction = require('../src/modules/inventory/inventoryTransaction.model');
const Order = require('../src/modules/orders/order.model');
const orderService = require('../src/modules/orders/order.service');
const Product = require('../src/modules/products/product.model');
const ProductColour = require('../src/modules/productColours/productColour.model');
const SizeSet = require('../src/modules/sizeSets/sizeSet.model');
const SubCategory = require('../src/modules/subcategories/subCategory.model');
const User = require('../src/modules/users/user.model');
const ProductVariant = require('../src/modules/variants/productVariant.model');
const { generateAccessToken } = require('../src/utils/jwt');

const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
const address = { name: 'Confirmation Buyer', phone: '9876543210', addressLine1: '101 Market', addressLine2: '', city: 'Surat', state: 'Gujarat', postalCode: '395002' };
const shelfValues = (inventory) => inventory.shelves.map(({ shelf, quantity }) => ({ shelf, quantity })).sort((a, b) => a.shelf.localeCompare(b.shelf));

test('Admin final confirmation is one atomic stock transaction', { timeout: 120000, skip: !URI && 'ORDER_CONFIRMATION_TEST_MONGODB_URI replica-set URI is required' }, async (t) => {
  let server;
  try {
    await mongoose.connect(URI);
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    assert.ok(hello.setName || hello.msg === 'isdbgrid', 'Confirmation tests require a transaction-capable MongoDB deployment');
    await mongoose.connection.dropDatabase();

    const password = 'Confirmation-Test-1!';
    const [admin, wholesaler] = await User.create([
      { name: 'Admin', email: 'confirm-admin@example.test', phone: '9000000001', password, role: 'admin', status: 'active' },
      { name: 'Wholesaler', email: 'confirm-wholesaler@example.test', phone: '9000000002', password, role: 'wholesaler', status: 'active', discountPercent: 10 },
    ]);
    const retailer = await User.create({ name: 'Retailer', email: 'confirm-retailer@example.test', phone: '9000000003', password, role: 'retailer', status: 'active', parentWholesaler: wholesaler._id, discountPercent: 12 });
    const category = await Category.create({ name: 'Confirmation Category', status: 'active' });
    const subCategory = await SubCategory.create({ category: category._id, name: 'Confirmation Subcategory', status: 'active' });
    const [fit, fabric, black, blue, sizeSet] = await Promise.all([
      Fit.create({ name: 'Confirm Fit', status: 'active' }),
      Fabric.create({ name: 'Confirm Fabric', status: 'active' }),
      Colour.create({ name: 'Confirm Black', status: 'active' }),
      Colour.create({ name: 'Confirm Blue', status: 'active' }),
      SizeSet.create({ label: 'Confirm S-XL', sizes: ['S', 'M', 'L', 'XL'], pieceCount: 4, status: 'active' }),
    ]);
    const product = await Product.create({ catalogVersion: 2, name: 'CONFIRMATION', category: category._id, subCategory: subCategory._id, fitId: fit._id, fabricId: fabric._id, mrpPerPieceMinor: 10000, status: 'active' });
    const [blackPc, bluePc] = await ProductColour.create([
      { product: product._id, colour: black._id, productCode: 'confirm_black', images: [], status: 'active' },
      { product: product._id, colour: blue._id, productCode: 'confirm_blue', images: [], status: 'active' },
    ]);
    const [blackSku, blueSku] = await ProductVariant.create([
      { catalogVersion: 2, product: product._id, productColour: blackPc._id, sizeSetRef: sizeSet._id, sku: 'confirm_black_s-xl', status: 'active' },
      { catalogVersion: 2, product: product._id, productColour: bluePc._id, sizeSetRef: sizeSet._id, sku: 'confirm_blue_s-xl', status: 'active' },
    ]);
    await Inventory.create([
      { variant: blackSku._id, sku: blackSku.sku, shelves: [] },
      { variant: blueSku._id, sku: blueSku.sku, shelves: [] },
    ]);

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const tokens = { admin: generateAccessToken(admin), wholesaler: generateAccessToken(wholesaler) };
    const request = async (path, { method = 'GET', token, body } = {}) => {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };

    const reset = async ({ blackShelves = [], blueShelves = [] } = {}) => {
      await Promise.all([Order.deleteMany({}), InventoryTransaction.deleteMany({})]);
      const setInventory = (variant, shelves) => {
        const total = shelves.reduce((sum, entry) => sum + entry.quantity, 0);
        return Inventory.updateOne({ variant: variant._id }, { $set: { shelves, availableQuantity: total, totalQuantity: total, status: total ? 'in_stock' : 'out_of_stock' } });
      };
      await Promise.all([setInventory(blackSku, blackShelves), setInventory(blueSku, blueShelves)]);
    };
    const createDirect = (items) => orderService.createOrder({ items, deliveryAddress: address }, wholesaler);
    const createRetailer = (items) => orderService.createOrder({ items, deliveryAddress: address }, retailer);
    const confirmApi = (id, token = tokens.admin) => request(`/orders/${id}/admin-confirm`, { method: 'POST', token });
    const inventoryFor = (variant) => Inventory.findOne({ variant: variant._id }).lean();

    await t.test('successful one-SKU confirmation creates audit and ledger', async () => {
      await reset({ blackShelves: [{ shelf: 'A', quantity: 5 }] });
      const order = await createDirect([{ skuId: blackSku._id.toString(), setQuantity: 3 }]);
      const response = await confirmApi(order._id);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.data.status, 'CONFIRMED');
      assert.equal(response.body.data.confirmedBy._id, admin._id.toString());
      assert.ok(response.body.data.confirmedAt);
      assert.equal(response.body.data.history.at(-1).type, 'ADMIN_CONFIRMED');
      assert.deepEqual(shelfValues(await inventoryFor(blackSku)), [{ shelf: 'A', quantity: 2 }]);
      const ledger = await InventoryTransaction.find({ variant: blackSku._id }).lean();
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].type, 'ORDER_DEDUCT');
      assert.equal(ledger[0].quantity, 3);
      assert.equal(ledger[0].referenceId, `ORDER:${order._id}`);
    });

    await t.test('multi-SKU confirmation and smaller-shelf-first allocation', async () => {
      await reset({ blackShelves: [{ shelf: 'A', quantity: 10 }, { shelf: 'B', quantity: 5 }], blueShelves: [{ shelf: 'C', quantity: 4 }] });
      const order = await createDirect([{ skuId: blackSku._id.toString(), setQuantity: 7 }, { skuId: blueSku._id.toString(), setQuantity: 2 }]);
      await orderService.confirmAdminOrder(order._id, admin);
      assert.deepEqual(shelfValues(await inventoryFor(blackSku)), [{ shelf: 'A', quantity: 8 }]);
      assert.deepEqual(shelfValues(await inventoryFor(blueSku)), [{ shelf: 'C', quantity: 2 }]);
      const blackLedger = await InventoryTransaction.find({ variant: blackSku._id }).sort({ createdAt: 1, _id: 1 }).lean();
      assert.deepEqual(blackLedger.map(({ fromShelf, quantity }) => ({ fromShelf, quantity })), [{ fromShelf: 'B', quantity: 5 }, { fromShelf: 'A', quantity: 2 }]);
    });

    await t.test('removed item is ignored and adjusted item uses currentSetQty', async () => {
      await reset({ blackShelves: [{ shelf: 'A', quantity: 10 }], blueShelves: [{ shelf: 'B', quantity: 10 }] });
      const order = await createDirect([{ skuId: blackSku._id.toString(), setQuantity: 7 }, { skuId: blueSku._id.toString(), setQuantity: 4 }]);
      const blackItem = order.items.find(({ sku }) => sku === blackSku.sku);
      const blueItem = order.items.find(({ sku }) => sku === blueSku.sku);
      await orderService.adjustAdminOrder(order._id, { items: [{ orderItemId: blackItem._id.toString(), setQuantity: 2 }, { orderItemId: blueItem._id.toString(), setQuantity: 0 }] }, admin);
      await orderService.confirmAdminOrder(order._id, admin);
      assert.deepEqual(shelfValues(await inventoryFor(blackSku)), [{ shelf: 'A', quantity: 8 }]);
      assert.deepEqual(shelfValues(await inventoryFor(blueSku)), [{ shelf: 'B', quantity: 10 }]);
      assert.equal(await InventoryTransaction.countDocuments({ variant: blueSku._id }), 0);
    });

    await t.test('insufficient first item aborts without mutation', async () => {
      await reset({ blackShelves: [{ shelf: 'A', quantity: 2 }] });
      const order = await createDirect([{ skuId: blackSku._id.toString(), setQuantity: 3 }]);
      await assert.rejects(orderService.confirmAdminOrder(order._id, admin), /Insufficient stock.*Available: 2/);
      assert.deepEqual(shelfValues(await inventoryFor(blackSku)), [{ shelf: 'A', quantity: 2 }]);
      assert.equal(await InventoryTransaction.countDocuments({}), 0);
      assert.equal((await Order.findById(order._id).lean()).status, 'PENDING_ADMIN');
    });

    await t.test('insufficient later item rolls earlier SKU and ledger back', async () => {
      await reset({ blackShelves: [{ shelf: 'A', quantity: 5 }], blueShelves: [{ shelf: 'B', quantity: 1 }] });
      const order = await createDirect([{ skuId: blackSku._id.toString(), setQuantity: 4 }, { skuId: blueSku._id.toString(), setQuantity: 2 }]);
      await assert.rejects(orderService.confirmAdminOrder(order._id, admin), /Insufficient stock/);
      assert.deepEqual(shelfValues(await inventoryFor(blackSku)), [{ shelf: 'A', quantity: 5 }]);
      assert.deepEqual(shelfValues(await inventoryFor(blueSku)), [{ shelf: 'B', quantity: 1 }]);
      assert.equal(await InventoryTransaction.countDocuments({}), 0);
      assert.equal((await Order.findById(order._id).lean()).status, 'PENDING_ADMIN');
    });

    await t.test('injected failure after stock mutation rolls inventory and ledger back', async () => {
      await reset({ blackShelves: [{ shelf: 'A', quantity: 5 }] });
      const order = await createDirect([{ skuId: blackSku._id.toString(), setQuantity: 3 }]);
      await assert.rejects(orderService.confirmAdminOrder(order._id, admin, { afterItemDeduction: () => { throw new Error('injected after stock mutation'); } }), /injected after stock mutation/);
      assert.deepEqual(shelfValues(await inventoryFor(blackSku)), [{ shelf: 'A', quantity: 5 }]);
      assert.equal(await InventoryTransaction.countDocuments({}), 0);
      assert.equal((await Order.findById(order._id).lean()).status, 'PENDING_ADMIN');
    });

    await t.test('failure immediately before Order save rolls everything back', async () => {
      await reset({ blackShelves: [{ shelf: 'A', quantity: 5 }] });
      const order = await createDirect([{ skuId: blackSku._id.toString(), setQuantity: 3 }]);
      await assert.rejects(orderService.confirmAdminOrder(order._id, admin, { beforeOrderSave: () => { throw new Error('injected before Order save'); } }), /injected before Order save/);
      assert.deepEqual(shelfValues(await inventoryFor(blackSku)), [{ shelf: 'A', quantity: 5 }]);
      assert.equal(await InventoryTransaction.countDocuments({}), 0);
      assert.equal((await Order.findById(order._id).lean()).status, 'PENDING_ADMIN');
    });

    await t.test('competing confirmations and retries cannot double-deduct', async () => {
      await reset({ blackShelves: [{ shelf: 'A', quantity: 5 }] });
      const order = await createDirect([{ skuId: blackSku._id.toString(), setQuantity: 4 }]);
      const competing = await Promise.allSettled([orderService.confirmAdminOrder(order._id, admin), orderService.confirmAdminOrder(order._id, admin)]);
      assert.equal(competing.filter(({ status }) => status === 'fulfilled').length, 1);
      assert.equal(competing.filter(({ status }) => status === 'rejected').length, 1);
      assert.match(competing.find(({ status }) => status === 'rejected').reason.message, /current status is CONFIRMED/);
      assert.deepEqual(shelfValues(await inventoryFor(blackSku)), [{ shelf: 'A', quantity: 1 }]);
      assert.equal(await InventoryTransaction.countDocuments({}), 1);
      await assert.rejects(orderService.confirmAdminOrder(order._id, admin), /current status is CONFIRMED/);
      assert.deepEqual(shelfValues(await inventoryFor(blackSku)), [{ shelf: 'A', quantity: 1 }]);
      assert.equal(await InventoryTransaction.countDocuments({}), 1);
    });

    await t.test('invalid states and non-Admin actor cannot confirm', async () => {
      await reset({ blackShelves: [{ shelf: 'A', quantity: 10 }] });
      const pendingWholesaler = await createRetailer([{ skuId: blackSku._id.toString(), setQuantity: 1 }]);
      assert.equal((await confirmApi(pendingWholesaler._id)).status, 409);
      const cancelled = await createDirect([{ skuId: blackSku._id.toString(), setQuantity: 1 }]);
      await orderService.cancelOrder(cancelled._id, wholesaler);
      assert.equal((await confirmApi(cancelled._id)).status, 409);
      const pendingAdmin = await createDirect([{ skuId: blackSku._id.toString(), setQuantity: 1 }]);
      assert.equal((await confirmApi(pendingAdmin._id, tokens.wholesaler)).status, 403);
      const confirmed = await createDirect([{ skuId: blackSku._id.toString(), setQuantity: 1 }]);
      await orderService.confirmAdminOrder(confirmed._id, admin);
      assert.equal((await confirmApi(confirmed._id)).status, 409);
    });
  } finally {
    if (server) await close(server);
    if (mongoose.connection.readyState) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
  }
});
