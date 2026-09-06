const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.JWT_EXPIRES_IN = '1h';
const URI = process.env.NOTIFICATION_TEST_MONGODB_URI;

const app = require('../src/app');
const Category = require('../src/modules/categories/category.model');
const Colour = require('../src/modules/colours/colour.model');
const DeviceToken = require('../src/modules/notifications/deviceToken.model');
const NotificationOutbox = require('../src/modules/notifications/notificationOutbox.model');
const provider = require('../src/modules/notifications/notificationProvider.service');
const Fabric = require('../src/modules/fabrics/fabric.model');
const Fit = require('../src/modules/fits/fit.model');
const Inventory = require('../src/modules/inventory/inventory.model');
const Order = require('../src/modules/orders/order.model');
const orderService = require('../src/modules/orders/order.service');
const Product = require('../src/modules/products/product.model');
const ProductColour = require('../src/modules/productColours/productColour.model');
const SizeSet = require('../src/modules/sizeSets/sizeSet.model');
const SubCategory = require('../src/modules/subcategories/subCategory.model');
const User = require('../src/modules/users/user.model');
const Variant = require('../src/modules/variants/productVariant.model');
const { generateAccessToken } = require('../src/utils/jwt');

const address = { name: 'Push Buyer', phone: '9876543210', addressLine1: 'Push Market', addressLine2: '', city: 'Surat', state: 'Gujarat', postalCode: '395002' };
const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

test('FCM device ownership and finalized Order notification recipients', { timeout: 120000, skip: !URI && 'NOTIFICATION_TEST_MONGODB_URI replica-set URI is required' }, async (t) => {
  let server;
  const deliveries = [];
  let providerMode = 'success';
  provider.setNotificationProvider({
    async sendMulticast(message) {
      deliveries.push(message);
      if (providerMode === 'throw') throw new Error('Firebase unavailable');
      return { responses: message.tokens.map((token) => providerMode === 'dead' && token.includes('dead')
        ? { success: false, errorCode: 'messaging/registration-token-not-registered' }
        : { success: true }) };
    },
  });
  try {
    await mongoose.connect(URI);
    assert.ok((await mongoose.connection.db.admin().command({ hello: 1 })).setName);
    await mongoose.connection.dropDatabase();
    const password = 'Push-Test-1!';
    const [admin, wholesaler, otherWholesaler] = await User.create([
      { name: 'Admin', email: 'push-admin@example.test', password, role: 'admin', status: 'active' },
      { name: 'Wholesaler', email: 'push-wholesaler@example.test', phone: '9876543210', password, role: 'wholesaler', status: 'active', discountPercent: 10 },
      { name: 'Other Wholesaler', email: 'push-other-wholesaler@example.test', phone: '9876543211', password, role: 'wholesaler', status: 'active' },
    ]);
    const [retailer, otherRetailer] = await User.create([
      { name: 'Retailer', email: 'push-retailer@example.test', phone: '9876543212', password, role: 'retailer', status: 'active', parentWholesaler: wholesaler._id, discountPercent: 12 },
      { name: 'Other Retailer', email: 'push-other-retailer@example.test', phone: '9876543213', password, role: 'retailer', status: 'active', parentWholesaler: otherWholesaler._id },
    ]);
    const category = await Category.create({ name: 'Push Category', slug: 'push-category' });
    const sub = await SubCategory.create({ category: category._id, name: 'Push Sub', slug: 'push-sub' });
    const [fit, fabric, colour, sizeSet] = await Promise.all([
      Fit.create({ name: 'Push Fit', slug: 'push-fit' }), Fabric.create({ name: 'Push Fabric', slug: 'push-fabric' }),
      Colour.create({ name: 'Push Black', slug: 'push-black' }), SizeSet.create({ label: 'Push S-L', sizes: ['S', 'M', 'L'] }),
    ]);
    const product = await Product.create({ catalogVersion: 2, name: 'Push Product', category: category._id, subCategory: sub._id, fitId: fit._id, fabricId: fabric._id, mrpPerPieceMinor: 10000 });
    const productColour = await ProductColour.create({ product: product._id, colour: colour._id, productCode: 'push_black' });
    const sku = await Variant.create({ catalogVersion: 2, product: product._id, productColour: productColour._id, sizeSetRef: sizeSet._id, sku: 'push_black_pushs-l' });
    await Inventory.create({ variant: sku._id, sku: sku.sku, shelves: [{ shelf: 'A', quantity: 100 }] });

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const tokens = Object.fromEntries(Object.entries({ admin, wholesaler, otherWholesaler, retailer, otherRetailer }).map(([key, user]) => [key, generateAccessToken(user)]));
    const request = async (path, { method = 'GET', token, body } = {}) => {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const register = (userToken, token, platform = 'android', deviceId) => request('/notifications/devices', { method: 'POST', token: userToken, body: { token, platform, ...(deviceId ? { deviceId } : {}) } });
    const fcm = {
      wholesale1: 'fcm-wholesaler-one-device-0001', wholesale2: 'fcm-wholesaler-two-device-0002',
      retailer: 'fcm-retailer-one-device-0003', otherWholesale: 'fcm-other-wholesaler-device-0004', otherRetailer: 'fcm-other-retailer-device-0005',
    };

    await t.test('users register multiple devices, duplicates are deterministic, and ownership protects unregister', async () => {
      const first = await register(tokens.wholesaler, fcm.wholesale1, 'android', 'wholesale-phone');
      const second = await register(tokens.wholesaler, fcm.wholesale2, 'ios', 'wholesale-tablet');
      assert.equal(first.status, 200); assert.equal(second.status, 200);
      const duplicate = await register(tokens.wholesaler, fcm.wholesale1, 'android', 'wholesale-phone');
      assert.equal(duplicate.status, 200); assert.equal(duplicate.body.data._id, first.body.data._id);
      assert.equal(await DeviceToken.countDocuments({ user: wholesaler._id, status: 'active' }), 2);
      assert.equal((await register(tokens.otherWholesaler, fcm.wholesale1)).status, 409);
      assert.equal((await request(`/notifications/devices/${first.body.data._id}`, { method: 'DELETE', token: tokens.otherWholesaler })).status, 404);
      assert.equal((await DeviceToken.findById(first.body.data._id)).status, 'active');
      const temporary = await register(tokens.retailer, 'fcm-temporary-retailer-device-0999');
      assert.equal((await request(`/notifications/devices/${temporary.body.data._id}`, { method: 'DELETE', token: tokens.retailer })).status, 200);
      assert.equal((await DeviceToken.findById(temporary.body.data._id)).status, 'inactive');
      await Promise.all([
        register(tokens.retailer, fcm.retailer), register(tokens.otherWholesaler, fcm.otherWholesale), register(tokens.otherRetailer, fcm.otherRetailer),
      ]);
    });

    const resetDeliveries = () => { deliveries.length = 0; providerMode = 'success'; };
    const createRetailerOrder = () => orderService.createOrder({ items: [{ skuId: sku._id.toString(), setQuantity: 2 }], deliveryAddress: address }, retailer);
    const createDirectOrder = () => orderService.createOrder({ items: [{ skuId: sku._id.toString(), setQuantity: 2 }], deliveryAddress: address }, wholesaler);
    const deliveredTokens = () => new Set(deliveries.flatMap(({ tokens: batch }) => batch));
    const assertOnly = (...expected) => assert.deepEqual(deliveredTokens(), new Set(expected));

    await t.test('Retailer submit and Wholesaler actions target only the owning hierarchy', async () => {
      resetDeliveries(); const submitted = await createRetailerOrder();
      assertOnly(fcm.wholesale1, fcm.wholesale2); assert.equal(deliveries[0].data.eventType, 'RETAILER_ORDER_SUBMITTED');
      assert.equal(deliveredTokens().has(fcm.otherWholesale), false);
      resetDeliveries(); await orderService.adjustWholesalerOrder(submitted._id, { items: [{ orderItemId: submitted.items[0]._id.toString(), setQuantity: 3 }] }, wholesaler);
      assertOnly(fcm.retailer); assert.equal(deliveries[0].data.eventType, 'WHOLESALER_ORDER_ADJUSTED');
      resetDeliveries(); await orderService.acceptWholesalerOrder(submitted._id, wholesaler);
      assertOnly(fcm.retailer); assert.equal(deliveries[0].data.eventType, 'WHOLESALER_ORDER_FORWARDED');
      resetDeliveries(); const cancelled = await createRetailerOrder(); resetDeliveries();
      await orderService.cancelOrder(cancelled._id, wholesaler, 'Unavailable');
      assertOnly(fcm.retailer); assert.equal(deliveries[0].data.eventType, 'WHOLESALER_ORDER_CANCELLED');
      assert.equal(deliveredTokens().has(fcm.otherRetailer), false);
    });

    await t.test('Admin adjust/cancel targets Wholesaler and also Retailer for Retailer-originated Orders', async () => {
      resetDeliveries(); const directAdjust = await createDirectOrder();
      await orderService.adjustAdminOrder(directAdjust._id, { items: [{ orderItemId: directAdjust.items[0]._id.toString(), setQuantity: 3 }] }, admin);
      assertOnly(fcm.wholesale1, fcm.wholesale2); assert.equal(deliveries[0].data.eventType, 'ADMIN_ORDER_ADJUSTED');
      resetDeliveries(); const directCancel = await createDirectOrder();
      await orderService.cancelOrder(directCancel._id, admin, 'Cancelled');
      assertOnly(fcm.wholesale1, fcm.wholesale2); assert.equal(deliveries[0].data.eventType, 'ADMIN_ORDER_CANCELLED');
      resetDeliveries(); const retailAdmin = await createRetailerOrder(); await orderService.acceptWholesalerOrder(retailAdmin._id, wholesaler); resetDeliveries();
      await orderService.adjustAdminOrder(retailAdmin._id, { items: [{ orderItemId: retailAdmin.items[0]._id.toString(), setQuantity: 4 }] }, admin);
      assertOnly(fcm.wholesale1, fcm.wholesale2, fcm.retailer);
      resetDeliveries(); await orderService.cancelOrder(retailAdmin._id, admin, 'Admin cancelled');
      assertOnly(fcm.wholesale1, fcm.wholesale2, fcm.retailer);
      assert.equal(deliveredTokens().has(fcm.otherWholesale), false); assert.equal(deliveredTokens().has(fcm.otherRetailer), false);
    });

    await t.test('failed persistence emits nothing and confirmation emits only after commit', async () => {
      resetDeliveries();
      await assert.rejects(
        orderService.createOrder(
          { items: [{ skuId: sku._id.toString(), setQuantity: 2 }], deliveryAddress: address },
          retailer,
          undefined,
          { beforeOrderSave: ({ order }) => { order.orderNumber = 'invalid'; } },
        ),
        /Order validation failed/,
      );
      assert.equal(deliveries.length, 0);
      const direct = await createDirectOrder(); resetDeliveries();
      await orderService.confirmAdminOrder(direct._id, admin, {
        afterItemDeduction: () => assert.equal(deliveries.length, 0),
        beforeOrderSave: () => assert.equal(deliveries.length, 0),
      });
      assertOnly(fcm.wholesale1, fcm.wholesale2); assert.equal(deliveries[0].data.eventType, 'ADMIN_ORDER_CONFIRMED');
    });

    await t.test('Retailer-originated confirmation targets both recipients without cross-Wholesaler leakage', async () => {
      const order = await createRetailerOrder(); await orderService.acceptWholesalerOrder(order._id, wholesaler); resetDeliveries();
      await orderService.confirmAdminOrder(order._id, admin);
      assertOnly(fcm.wholesale1, fcm.wholesale2, fcm.retailer);
      assert.equal(deliveredTokens().has(fcm.otherWholesale), false); assert.equal(deliveredTokens().has(fcm.otherRetailer), false);
    });

    await t.test('Firebase failure cannot roll back confirmation and dead tokens are deactivated', async () => {
      const failing = await createDirectOrder(); resetDeliveries(); providerMode = 'throw';
      await orderService.confirmAdminOrder(failing._id, admin);
      assert.equal((await Order.findById(failing._id)).status, 'CONFIRMED');
      assert.equal((await NotificationOutbox.findOne({ 'payload.orderId': failing._id.toString(), eventType: 'ADMIN_ORDER_CONFIRMED' })).status, 'FAILED');
      const dead = await register(tokens.retailer, 'fcm-dead-retailer-device-0006', 'android', 'dead-phone');
      providerMode = 'dead'; deliveries.length = 0;
      const pending = await createRetailerOrder(); await orderService.acceptWholesalerOrder(pending._id, wholesaler);
      assert.equal((await DeviceToken.findById(dead.body.data._id)).status, 'inactive');
      assert.equal((await Order.findById(pending._id)).status, 'PENDING_ADMIN');
    });
  } finally {
    provider.resetNotificationProvider();
    if (server) await close(server);
    await mongoose.disconnect();
  }
});
