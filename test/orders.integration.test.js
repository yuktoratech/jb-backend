const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.JWT_EXPIRES_IN = '1h';
const URI = process.env.ORDER_TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/jb_b2b_order_test';
if (!/^jb_b2b_order_test(?:_|$)/.test(new URL(URI).pathname.slice(1))) throw new Error('ORDER_TEST_MONGODB_URI must target a safe test database');

const app = require('../src/app');
const Category = require('../src/modules/categories/category.model');
const Colour = require('../src/modules/colours/colour.model');
const Fabric = require('../src/modules/fabrics/fabric.model');
const Fit = require('../src/modules/fits/fit.model');
const Inventory = require('../src/modules/inventory/inventory.model');
const InventoryTransaction = require('../src/modules/inventory/inventoryTransaction.model');
const Order = require('../src/modules/orders/order.model');
const orderPricing = require('../src/modules/orders/orderPricing.service');
const Product = require('../src/modules/products/product.model');
const ProductColour = require('../src/modules/productColours/productColour.model');
const SizeSet = require('../src/modules/sizeSets/sizeSet.model');
const SubCategory = require('../src/modules/subcategories/subCategory.model');
const User = require('../src/modules/users/user.model');
const ProductVariant = require('../src/modules/variants/productVariant.model');
const { generateAccessToken } = require('../src/utils/jwt');

const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
const address = { name: 'Test Buyer', phone: '9876543210', addressLine1: '101 Textile Market', addressLine2: '', city: 'Surat', state: 'Gujarat', postalCode: '395002' };

test('Order percentages use deterministic half-up rounding to one paise', () => {
  assert.equal(orderPricing.percentageOfMinor(1, 50), 1);
  assert.equal(orderPricing.percentageOfMinor(1, 49), 0);
  assert.equal(orderPricing.percentageOfMinor(101, 12.5), 13);
});

test('finalized Order state machine and pricing snapshots are enforced', { timeout: 90000 }, async () => {
  let server;
  try {
    await mongoose.connect(URI);
    await mongoose.connection.dropDatabase();
    const password = 'Order-Test-Password-1!';
    const [admin, wholesaler] = await User.create([
      { name: 'Admin', email: 'order-admin@example.test', phone: '9000000001', password, role: 'admin', status: 'active' },
      { name: 'Wholesaler', email: 'order-wholesaler@example.test', phone: '9000000002', password, role: 'wholesaler', status: 'active', discountPercent: 10 },
    ]);
    const retailer = await User.create({ name: 'Retailer', email: 'order-retailer@example.test', phone: '9000000003', password, role: 'retailer', status: 'active', parentWholesaler: wholesaler._id, discountPercent: 20 });

    const category = await Category.create({ name: 'Order Category', slug: 'order-category', status: 'active' });
    const subCategory = await SubCategory.create({ category: category._id, name: 'Order Subcategory', slug: 'order-subcategory', status: 'active' });
    const [fit, fabric, black, blue, sizeSet] = await Promise.all([
      Fit.create({ name: 'Regular', slug: 'regular', status: 'active' }),
      Fabric.create({ name: 'Cotton', slug: 'cotton', status: 'active' }),
      Colour.create({ name: 'Black', slug: 'black', status: 'active' }),
      Colour.create({ name: 'Blue', slug: 'blue', status: 'active' }),
      SizeSet.create({ label: 'S-XXL', sizes: ['S', 'M', 'L', 'XL', 'XXL'], pieceCount: 5, status: 'active' }),
    ]);
    const product = await Product.create({ catalogVersion: 2, name: 'Snapshot Shirt', category: category._id, subCategory: subCategory._id, fitId: fit._id, fabricId: fabric._id, mrpPerPieceMinor: 100000, status: 'active' });
    const [blackPc, bluePc] = await ProductColour.create([
      { product: product._id, colour: black._id, productCode: 'snapshot_black', images: [], status: 'active' },
      { product: product._id, colour: blue._id, productCode: 'snapshot_blue', images: [], status: 'active' },
    ]);
    const [blackSku, blueSku] = await ProductVariant.create([
      { catalogVersion: 2, product: product._id, productColour: blackPc._id, sizeSetRef: sizeSet._id, sku: 'snapshot_black_s-xxl', status: 'active' },
      { catalogVersion: 2, product: product._id, productColour: bluePc._id, sizeSetRef: sizeSet._id, sku: 'snapshot_blue_s-xxl', status: 'active' },
    ]);
    await Inventory.create([
      { variant: blackSku._id, sku: blackSku.sku, shelves: [{ shelf: 'A1', quantity: 50 }] },
      { variant: blueSku._id, sku: blueSku.sku, shelves: [{ shelf: 'B1', quantity: 50 }] },
    ]);

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const tokens = { admin: generateAccessToken(admin), wholesaler: generateAccessToken(wholesaler), retailer: generateAccessToken(retailer) };
    const request = async (path, { method = 'GET', token, body } = {}) => {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const createOrder = (token, items) => request('/orders', { method: 'POST', token, body: { items, deliveryAddress: address } });
    const inventorySnapshot = async () => ({
      inventories: (await Inventory.find({}).sort({ sku: 1 }).lean()).map(({ sku, shelves, availableQuantity, totalQuantity }) => ({ sku, shelves: shelves.map(({ shelf, quantity }) => ({ shelf, quantity })), availableQuantity, totalQuantity })),
      transactionCount: await InventoryTransaction.countDocuments({}),
    });
    const baseline = await inventorySnapshot();
    const assertInventoryUnchanged = async () => assert.deepEqual(await inventorySnapshot(), baseline);

    const direct = await createOrder(tokens.wholesaler, [{ skuId: blackSku._id, setQuantity: 3 }]);
    assert.equal(direct.status, 201, JSON.stringify(direct.body));
    assert.equal(direct.body.data.status, 'PENDING_ADMIN');
    assert.equal(direct.body.data.grossAmountMinor, 1500000);
    assert.equal(direct.body.data.discountPercent, 10);
    assert.equal(direct.body.data.discountAmountMinor, 150000);
    assert.equal(direct.body.data.taxableAmountMinor, 1350000);
    assert.equal(direct.body.data.gstPercent, 5);
    assert.equal(direct.body.data.gstAmountMinor, 67500);
    assert.equal(direct.body.data.finalAmountMinor, 1417500);
    assert.equal(direct.body.data.items[0].piecesPerSet, 5);
    assert.equal(direct.body.data.items[0].productId, product._id.toString());
    assert.equal(direct.body.data.items[0].productColourId, blackPc._id.toString());
    assert.equal(direct.body.data.items[0].skuId, blackSku._id.toString());
    assert.equal(direct.body.data.items[0].sizeSetLabel, 'S-XXL');
    assert.deepEqual(direct.body.data.items[0].sizes, ['S', 'M', 'L', 'XL', 'XXL']);
    assert.equal(direct.body.data.items[0].mrpPerPieceMinor, 100000);
    assert.equal(direct.body.data.items[0].setMrpMinor, 500000);
    assert.equal(direct.body.data.items[0].originalSetQty, 3);
    assert.equal(direct.body.data.items[0].originalPieceQty, 15);
    assert.equal(direct.body.data.items[0].currentPieceQty, 15);
    assert.equal(direct.body.data.inventoryStatus, undefined);
    await assertInventoryUnchanged();

    const retailerPending = await createOrder(tokens.retailer, [{ skuId: blackSku._id, setQuantity: 3 }]);
    assert.equal(retailerPending.status, 201);
    assert.equal(retailerPending.body.data.status, 'PENDING_WHOLESALER');
    assert.equal(retailerPending.body.data.discountPercent, 20);
    assert.equal(retailerPending.body.data.discountAmountMinor, 300000);
    assert.equal(retailerPending.body.data.finalAmountMinor, 1260000);
    await assertInventoryUnchanged();

    const accepted = await request(`/orders/${retailerPending.body.data._id}/wholesaler-accept`, { method: 'POST', token: tokens.wholesaler });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.data.status, 'PENDING_ADMIN');
    assert.equal(accepted.body.data.history.at(-1).type, 'WHOLESALER_ACCEPTED');
    const lateRetailerCancel = await request(`/orders/${retailerPending.body.data._id}/retailer-cancel`, { method: 'POST', token: tokens.retailer, body: {} });
    assert.equal(lateRetailerCancel.status, 409);
    await assertInventoryUnchanged();

    const retailerCancellationFixture = await createOrder(tokens.retailer, [{ skuId: blackSku._id, setQuantity: 1 }]);
    const retailerCancelled = await request(`/orders/${retailerCancellationFixture.body.data._id}/retailer-cancel`, { method: 'POST', token: tokens.retailer, body: { reason: 'Changed mind' } });
    assert.equal(retailerCancelled.status, 200);
    assert.equal(retailerCancelled.body.data.status, 'CANCELLED');
    assert.equal(retailerCancelled.body.data.history.at(-1).type, 'RETAILER_CANCELLED');

    const directCancelled = await request(`/orders/${direct.body.data._id}/wholesaler-cancel`, { method: 'POST', token: tokens.wholesaler, body: {} });
    assert.equal(directCancelled.status, 200);
    assert.equal(directCancelled.body.data.status, 'CANCELLED');
    assert.equal(directCancelled.body.data.rejectedBy, undefined);
    await assertInventoryUnchanged();

    const adjustable = await createOrder(tokens.retailer, [
      { skuId: blackSku._id, setQuantity: 3 },
      { skuId: blueSku._id, setQuantity: 2 },
    ]);
    const originalBlack = adjustable.body.data.items.find(({ sku }) => sku === blackSku.sku);
    const originalBlue = adjustable.body.data.items.find(({ sku }) => sku === blueSku.sku);
    await Product.updateOne({ _id: product._id }, { $set: { mrpPerPieceMinor: 999999 } });
    await User.updateOne({ _id: retailer._id }, { $set: { discountPercent: 1 } });
    const wholesalerAdjusted = await request(`/orders/${adjustable.body.data._id}/wholesaler-adjust`, {
      method: 'PATCH', token: tokens.wholesaler,
      body: { items: [{ orderItemId: originalBlack._id, setQuantity: 2 }, { orderItemId: originalBlue._id, setQuantity: 0 }] },
    });
    assert.equal(wholesalerAdjusted.status, 200, JSON.stringify(wholesalerAdjusted.body));
    const adjustedBlack = wholesalerAdjusted.body.data.items.find(({ sku }) => sku === blackSku.sku);
    const removedBlue = wholesalerAdjusted.body.data.items.find(({ sku }) => sku === blueSku.sku);
    assert.equal(adjustedBlack.originalSetQty, 3);
    assert.equal(adjustedBlack.currentSetQty, 2);
    assert.equal(adjustedBlack.currentPieceQty, 10);
    assert.equal(adjustedBlack.mrpPerPieceMinor, 100000);
    assert.equal(removedBlue.originalSetQty, 2);
    assert.equal(removedBlue.currentSetQty, 0);
    assert.equal(removedBlue.isRemoved, true);
    assert.equal(wholesalerAdjusted.body.data.discountPercent, 20);
    assert.equal(wholesalerAdjusted.body.data.grossAmountMinor, 1000000);
    assert.equal(wholesalerAdjusted.body.data.finalAmountMinor, 840000);

    const addAttempt = await request(`/orders/${adjustable.body.data._id}/wholesaler-adjust`, { method: 'PATCH', token: tokens.wholesaler, body: { items: [{ orderItemId: new mongoose.Types.ObjectId(), setQuantity: 1 }] } });
    assert.equal(addAttempt.status, 400);
    const forwarded = await request(`/orders/${adjustable.body.data._id}/wholesaler-confirm`, { method: 'POST', token: tokens.wholesaler });
    assert.equal(forwarded.status, 200);
    const adminAdjusted = await request(`/orders/${adjustable.body.data._id}/admin-adjust`, { method: 'PATCH', token: tokens.admin, body: { items: [{ orderItemId: originalBlack._id, setQuantity: 1 }] } });
    assert.equal(adminAdjusted.status, 200);
    assert.equal(adminAdjusted.body.data.items.find(({ sku }) => sku === blackSku.sku).originalSetQty, 3);
    assert.equal(adminAdjusted.body.data.items.find(({ sku }) => sku === blackSku.sku).currentPieceQty, 5);
    assert.equal(adminAdjusted.body.data.finalAmountMinor, 420000);
    await assertInventoryUnchanged();

    const adminCancelled = await request(`/orders/${adjustable.body.data._id}/admin-cancel`, { method: 'POST', token: tokens.admin, body: { reason: 'Cancelled before confirmation' } });
    assert.equal(adminCancelled.status, 200);
    assert.equal(adminCancelled.body.data.status, 'CANCELLED');
    assert.equal(adminCancelled.body.data.history.at(-1).type, 'ADMIN_CANCELLED');
    assert.equal(await Order.countDocuments({ status: 'REJECTED' }), 0);
    await assertInventoryUnchanged();

    const notesRejected = await request('/orders', { method: 'POST', token: tokens.wholesaler, body: { items: [{ skuId: blackSku._id, setQuantity: 1 }], deliveryAddress: address, notes: 'not allowed' } });
    assert.equal(notesRejected.status, 400);
  } finally {
    if (server) await close(server);
    if (mongoose.connection.readyState) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
  }
});
