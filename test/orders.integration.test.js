const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');

const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.JWT_EXPIRES_IN = '1h';

const TEST_DATABASE_URI =
  process.env.ORDERS_TEST_MONGODB_URI ||
  'mongodb://127.0.0.1:27017/jb_b2b_orders_test';
const databaseName = new URL(TEST_DATABASE_URI).pathname.slice(1);

if (!/^jb_b2b_orders_test(?:_|$)/.test(databaseName)) {
  throw new Error(
    'ORDERS_TEST_MONGODB_URI must target a jb_b2b_orders_test database',
  );
}

const app = require('../src/app');
const Category = require('../src/modules/categories/category.model');
const Inventory = require('../src/modules/inventory/inventory.model');
const InventoryTransaction = require('../src/modules/inventory/inventoryTransaction.model');
const Order = require('../src/modules/orders/order.model');
const Product = require('../src/modules/products/product.model');
const productService = require('../src/modules/products/product.service');
const ProductVariant = require('../src/modules/variants/productVariant.model');
const User = require('../src/modules/users/user.model');
const { generateAccessToken } = require('../src/utils/jwt');

const closeServer = (server) =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

const deliveryAddress = {
  name: 'Just Black Test Buyer',
  phone: '9876543210',
  addressLine1: '101 Textile Market',
  addressLine2: 'Ring Road',
  city: 'Surat',
  state: 'Gujarat',
  postalCode: '395002',
};

const findVariant = (productResult, color) =>
  productResult.variants.find((group) => group.color === color).sizeSets[0];

const assertStatus = (response, expectedStatus, label) => {
  assert.equal(
    response.status,
    expectedStatus,
    `${label}: ${JSON.stringify(response.body)}`,
  );
};

const getInventory = (variantId) =>
  Inventory.findOne({ variant: variantId }).lean();

const getOrderTransactions = (orderId) =>
  InventoryTransaction.find({
    source: 'order',
    referenceId: { $regex: `^${orderId.toString()}:` },
  })
    .sort({ createdAt: 1, _id: 1 })
    .lean();

test(
  'order APIs enforce workflow, pricing, inventory, ownership, and audit rules',
  { timeout: 120000 },
  async () => {
    let server;

    try {
      await mongoose.connect(TEST_DATABASE_URI);
      await mongoose.connection.dropDatabase();

      const adminPassword = `Admin-${crypto.randomBytes(18).toString('base64url')}`;
      const sharedPassword = `Buyer-${crypto.randomBytes(18).toString('base64url')}`;
      const [admin, wholesalerA, wholesalerB, category] = await Promise.all([
        User.create({
          name: 'Order Admin',
          email: 'orders.admin@example.test',
          password: adminPassword,
          role: 'admin',
          status: 'active',
          isEmailVerified: true,
        }),
        User.create({
          name: 'Alpha Order Wholesale',
          email: 'orders.alpha.wholesale@example.test',
          password: sharedPassword,
          role: 'wholesaler',
          status: 'active',
          discountPercent: 12.5,
        }),
        User.create({
          name: 'Beta Order Wholesale',
          email: 'orders.beta.wholesale@example.test',
          password: sharedPassword,
          role: 'wholesaler',
          status: 'active',
          discountPercent: 5,
        }),
        Category.create({
          name: 'Order Integration Category',
          slug: 'order-integration-category',
          status: 'active',
        }),
      ]);

      const [retailerA, retailerB] = await Promise.all([
        User.create({
          name: 'Alpha Order Retail',
          email: 'orders.alpha.retail@example.test',
          password: sharedPassword,
          role: 'retailer',
          status: 'active',
          discountPercent: 10,
          parentWholesaler: wholesalerA._id,
        }),
        User.create({
          name: 'Beta Order Retail',
          email: 'orders.beta.retail@example.test',
          password: sharedPassword,
          role: 'retailer',
          status: 'active',
          discountPercent: 7,
          parentWholesaler: wholesalerB._id,
        }),
      ]);

      const catalog = await productService.createProduct({
        productName: 'ORDER SHIRT',
        productCode: 'ORDER-SHIRT',
        title: 'Order Integration Shirt',
        categoryId: category._id.toString(),
        mrp: 199.99,
        colors: [
          { color: 'BLACK', sizeSets: ['30-38'] },
          { color: 'NAVY', sizeSets: ['30-38'] },
          { color: 'WHITE', sizeSets: ['30-38'] },
          { color: 'GREEN', sizeSets: ['30-38'] },
        ],
      });
      const inactiveProductCatalog = await productService.createProduct({
        productName: 'INACTIVE ORDER SHIRT',
        productCode: 'INACTIVE-ORDER-SHIRT',
        title: 'Inactive Order Integration Shirt',
        categoryId: category._id.toString(),
        mrp: 149.5,
        colors: [{ color: 'GREY', sizeSets: ['30-38'] }],
      });

      const mainVariant = findVariant(catalog, 'BLACK');
      const secondaryVariant = findVariant(catalog, 'NAVY');
      const inactiveVariant = findVariant(catalog, 'WHITE');
      const concurrencyVariant = findVariant(catalog, 'GREEN');
      const inactiveProductVariant = findVariant(
        inactiveProductCatalog,
        'GREY',
      );

      await Promise.all([
        ProductVariant.updateOne(
          { _id: inactiveVariant.variantId },
          { $set: { status: 'inactive' } },
        ),
        Product.updateOne(
          { _id: inactiveProductCatalog.product._id },
          { $set: { status: 'inactive' } },
        ),
      ]);

      server = app.listen(0, '127.0.0.1');
      await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });

      const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
      const request = async (
        path,
        { method = 'GET', token, body, headers: requestHeaders = {} } = {},
      ) => {
        const headers = { ...requestHeaders };

        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }

        if (body !== undefined) {
          headers['Content-Type'] = 'application/json';
        }

        const response = await fetch(`${baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const responseBody = await response.json();

        return { body: responseBody, status: response.status };
      };

      const tokens = {
        admin: generateAccessToken(admin),
        wholesalerA: generateAccessToken(wholesalerA),
        wholesalerB: generateAccessToken(wholesalerB),
        retailerA: generateAccessToken(retailerA),
        retailerB: generateAccessToken(retailerB),
      };
      const createOrder = (
        token,
        items,
        overrides = {},
        requestHeaders = {},
      ) =>
        request('/orders', {
          method: 'POST',
          token,
          headers: requestHeaders,
          body: {
            items,
            deliveryAddress,
            ...overrides,
          },
        });
      const orderAction = (path, token, body, method = 'POST') =>
        request(path, { method, token, body });
      const addStock = async (variant, quantity, shelf) => {
        const response = await request('/inventory/adjust', {
          method: 'POST',
          token: tokens.admin,
          body: {
            sku: variant.sku,
            type: 'ADD',
            quantity,
            shelf,
          },
        });
        assertStatus(response, 200, `seed ${variant.sku} on ${shelf}`);
      };

      const health = await request('/health');
      assertStatus(health, 200, 'health smoke');
      assert.equal(health.body.success, true);

      const adminLogin = await request('/auth/login', {
        method: 'POST',
        body: { email: admin.email, password: adminPassword },
      });
      assertStatus(adminLogin, 200, 'existing Admin login smoke');

      await addStock(mainVariant, 10, 'A1');
      await addStock(mainVariant, 100, 'B2');
      await addStock(secondaryVariant, 50, 'C1');
      await addStock(concurrencyVariant, 5, 'Q1');

      const [categoriesSmoke, productsSmoke, inventorySmoke] =
        await Promise.all([
          request('/categories', { token: tokens.admin }),
          request('/products', { token: tokens.admin }),
          request('/inventory', { token: tokens.admin }),
        ]);
      assertStatus(categoriesSmoke, 200, 'existing Categories smoke');
      assertStatus(productsSmoke, 200, 'existing Products smoke');
      assertStatus(inventorySmoke, 200, 'existing Inventory smoke');

      const adminCannotOrder = await createOrder(tokens.admin, [
        { variantId: mainVariant.variantId, quantity: 1 },
      ]);
      assertStatus(adminCannotOrder, 403, 'Admin cannot place an order');

      const tamperedPayload = await createOrder(
        tokens.wholesalerA,
        [{ variantId: mainVariant.variantId, quantity: 1 }],
        {
          orderNumber: 'JB-20000101-000001',
          status: 'CONFIRMED',
          wholesalerId: wholesalerB._id.toString(),
          discountPercent: 99,
          totalAmount: 1,
        },
      );
      assertStatus(tamperedPayload, 400, 'frontend pricing/routing tampering');

      const duplicateVariant = await createOrder(tokens.wholesalerA, [
        { variantId: mainVariant.variantId, quantity: 1 },
        { variantId: mainVariant.variantId, quantity: 2 },
      ]);
      assertStatus(duplicateVariant, 400, 'duplicate variant validation');

      const zeroQuantity = await createOrder(tokens.wholesalerA, [
        { variantId: mainVariant.variantId, quantity: 0 },
      ]);
      assertStatus(zeroQuantity, 400, 'zero quantity validation');

      const fractionalQuantity = await createOrder(tokens.wholesalerA, [
        { variantId: mainVariant.variantId, quantity: 1.5 },
      ]);
      assertStatus(fractionalQuantity, 400, 'fractional quantity validation');

      const invalidDelivery = await createOrder(
        tokens.wholesalerA,
        [{ variantId: mainVariant.variantId, quantity: 1 }],
        { deliveryAddress: { ...deliveryAddress, phone: '12' } },
      );
      assertStatus(invalidDelivery, 400, 'delivery address validation');

      const missingVariant = await createOrder(tokens.wholesalerA, [
        { variantId: '000000000000000000000000', quantity: 1 },
      ]);
      assertStatus(missingVariant, 404, 'missing variant validation');

      const inactiveVariantOrder = await createOrder(tokens.wholesalerA, [
        { variantId: inactiveVariant.variantId, quantity: 1 },
      ]);
      assertStatus(inactiveVariantOrder, 409, 'inactive variant validation');

      const inactiveProductOrder = await createOrder(tokens.wholesalerA, [
        { variantId: inactiveProductVariant.variantId, quantity: 1 },
      ]);
      assertStatus(inactiveProductOrder, 409, 'inactive product validation');

      const inactiveAdjustmentBaseline = await getInventory(
        secondaryVariant.variantId,
      );
      const inactiveAdjustmentCreation = await createOrder(
        tokens.wholesalerA,
        [{ variantId: secondaryVariant.variantId, quantity: 2 }],
      );
      assertStatus(
        inactiveAdjustmentCreation,
        201,
        'create active variant adjustment fixture',
      );
      const inactiveAdjustmentOrder = inactiveAdjustmentCreation.body.data;
      await ProductVariant.updateOne(
        { _id: secondaryVariant.variantId },
        { $set: { status: 'inactive' } },
      );

      const inactiveVariantIncrease = await orderAction(
        `/orders/${inactiveAdjustmentOrder._id}/admin-adjust`,
        tokens.admin,
        {
          items: [
            {
              orderItemId: inactiveAdjustmentOrder.items[0]._id,
              quantity: 3,
            },
          ],
        },
        'PATCH',
      );
      assertStatus(
        inactiveVariantIncrease,
        409,
        'inactive variant cannot receive an increased reservation',
      );

      const inactiveVariantDecrease = await orderAction(
        `/orders/${inactiveAdjustmentOrder._id}/admin-adjust`,
        tokens.admin,
        {
          items: [
            {
              orderItemId: inactiveAdjustmentOrder.items[0]._id,
              quantity: 1,
            },
          ],
        },
        'PATCH',
      );
      assertStatus(
        inactiveVariantDecrease,
        200,
        'inactive variant reservation can be reduced safely',
      );
      const inactiveAdjustmentCleanup = await orderAction(
        `/orders/${inactiveAdjustmentOrder._id}/admin-reject`,
        tokens.admin,
        { reason: 'Cleanup inactive variant adjustment fixture' },
      );
      assertStatus(
        inactiveAdjustmentCleanup,
        200,
        'cleanup inactive variant adjustment fixture',
      );
      await ProductVariant.updateOne(
        { _id: secondaryVariant.variantId },
        { $set: { status: 'active' } },
      );
      const afterInactiveAdjustmentCleanup = await getInventory(
        secondaryVariant.variantId,
      );
      assert.equal(
        afterInactiveAdjustmentCleanup.availableQuantity,
        inactiveAdjustmentBaseline.availableQuantity,
      );
      assert.equal(afterInactiveAdjustmentCleanup.reservedQuantity, 0);

      const directBaseline = await getInventory(mainVariant.variantId);
      const directIdempotencyKey = 'direct-order-integration-0001';
      const directCreation = await createOrder(
        tokens.wholesalerA,
        [{ variantId: mainVariant.variantId, quantity: 12 }],
        {},
        { 'Idempotency-Key': directIdempotencyKey },
      );
      assertStatus(directCreation, 201, 'Wholesaler direct order creation');

      const directOrder = directCreation.body.data;
      assert.match(directOrder.orderNumber, /^JB-\d{8}-\d{6,12}$/);
      assert.equal(directOrder.sourceRole, 'wholesaler');
      assert.equal(directOrder.status, 'PENDING_ADMIN');
      assert.equal(directOrder.inventoryStatus, 'RESERVED');
      assert.equal(directOrder.placedBy._id, wholesalerA._id.toString());
      assert.equal(directOrder.wholesaler._id, wholesalerA._id.toString());
      assert.equal(directOrder.retailer, null);
      assert.equal(directOrder.totalPieces, 12);
      assert.equal(directOrder.subtotal, 2399.88);
      assert.equal(directOrder.discountAmount, 300);
      assert.equal(directOrder.totalAmount, 2099.88);
      assert.equal(directOrder.items[0].basePrice, 199.99);
      assert.equal(directOrder.items[0].discountPercent, 12.5);
      assert.equal(directOrder.items[0].unitPrice, 174.99);
      assert.equal(directOrder.items[0].inventoryAllocation, undefined);
      assert.deepEqual(
        directOrder.history.map(({ type }) => type),
        ['CREATED'],
      );

      const idempotentReplay = await createOrder(
        tokens.wholesalerA,
        [{ variantId: mainVariant.variantId, quantity: 12 }],
        {},
        { 'Idempotency-Key': directIdempotencyKey },
      );
      assertStatus(idempotentReplay, 201, 'idempotent create replay');
      assert.equal(idempotentReplay.body.data._id, directOrder._id);

      const conflictingReplay = await createOrder(
        tokens.wholesalerA,
        [{ variantId: mainVariant.variantId, quantity: 11 }],
        {},
        { 'Idempotency-Key': directIdempotencyKey },
      );
      assertStatus(conflictingReplay, 409, 'idempotency payload conflict');

      const concurrentIdempotencyKey = 'concurrent-idempotency-0001';
      const concurrentIdempotentPayload = [
        { variantId: secondaryVariant.variantId, quantity: 50 },
      ];
      const [concurrentIdempotentA, concurrentIdempotentB] =
        await Promise.all([
          createOrder(
            tokens.wholesalerA,
            concurrentIdempotentPayload,
            {},
            { 'Idempotency-Key': concurrentIdempotencyKey },
          ),
          createOrder(
            tokens.wholesalerA,
            concurrentIdempotentPayload,
            {},
            { 'Idempotency-Key': concurrentIdempotencyKey },
          ),
        ]);
      assertStatus(
        concurrentIdempotentA,
        201,
        'first concurrent idempotent request',
      );
      assertStatus(
        concurrentIdempotentB,
        201,
        'second concurrent idempotent request',
      );
      assert.equal(
        concurrentIdempotentA.body.data._id,
        concurrentIdempotentB.body.data._id,
      );
      assert.equal(concurrentIdempotentA.body.data.idempotencyKey, undefined);
      assert.equal(concurrentIdempotentA.body.data.requestFingerprint, undefined);
      assert.equal(
        await Order.countDocuments({
          placedBy: wholesalerA._id,
          idempotencyKey: concurrentIdempotencyKey,
        }),
        1,
      );
      const concurrentIdempotentInventory = await getInventory(
        secondaryVariant.variantId,
      );
      assert.equal(concurrentIdempotentInventory.reservedQuantity, 50);
      assert.equal(concurrentIdempotentInventory.availableQuantity, 0);

      const concurrentIdempotentCleanup = await orderAction(
        `/orders/${concurrentIdempotentA.body.data._id}/admin-reject`,
        tokens.admin,
        { reason: 'Cleanup concurrent idempotency fixture' },
      );
      assertStatus(
        concurrentIdempotentCleanup,
        200,
        'cleanup concurrent idempotency order',
      );
      const afterConcurrentIdempotentCleanup = await getInventory(
        secondaryVariant.variantId,
      );
      assert.equal(afterConcurrentIdempotentCleanup.reservedQuantity, 0);
      assert.equal(afterConcurrentIdempotentCleanup.availableQuantity, 50);

      const storedDirectOrder = await Order.findById(directOrder._id).lean();
      assert.deepEqual(storedDirectOrder.items[0].inventoryAllocation, [
        { shelf: 'A1', quantity: 10 },
        { shelf: 'B2', quantity: 2 },
      ]);

      const reservedDirectInventory = await getInventory(mainVariant.variantId);
      assert.equal(reservedDirectInventory.totalQuantity, directBaseline.totalQuantity);
      assert.equal(reservedDirectInventory.reservedQuantity, 12);
      assert.equal(
        reservedDirectInventory.availableQuantity,
        directBaseline.availableQuantity - 12,
      );
      assert.deepEqual(reservedDirectInventory.reservedShelves, [
        { shelf: 'A1', quantity: 10 },
        { shelf: 'B2', quantity: 2 },
      ]);

      await Product.updateOne(
        { _id: catalog.product._id },
        {
          $set: {
            productName: 'TEMPORARILY CHANGED PRODUCT',
            title: 'Temporarily Changed Product',
            mrp: 999,
          },
        },
      );
      const historicalSnapshot = await request(`/orders/${directOrder._id}`, {
        token: tokens.wholesalerA,
      });
      assertStatus(historicalSnapshot, 200, 'historical snapshot lookup');
      assert.equal(historicalSnapshot.body.data.items[0].productName, 'ORDER SHIRT');
      assert.equal(historicalSnapshot.body.data.items[0].basePrice, 199.99);
      await Product.updateOne(
        { _id: catalog.product._id },
        {
          $set: {
            productName: 'ORDER SHIRT',
            title: 'Order Integration Shirt',
            mrp: 199.99,
          },
        },
      );

      const confirmDirect = await orderAction(
        `/orders/${directOrder._id}/admin-confirm`,
        tokens.admin,
      );
      assertStatus(confirmDirect, 200, 'Admin confirms Wholesaler order');
      assert.equal(confirmDirect.body.data.status, 'CONFIRMED');
      assert.equal(confirmDirect.body.data.inventoryStatus, 'DEDUCTED');
      assert.deepEqual(
        confirmDirect.body.data.history.map(({ type }) => type),
        ['CREATED', 'ADMIN_CONFIRMED'],
      );

      const finalizedDirectInventory = await getInventory(mainVariant.variantId);
      assert.equal(
        finalizedDirectInventory.totalQuantity,
        directBaseline.totalQuantity - 12,
      );
      assert.equal(finalizedDirectInventory.reservedQuantity, 0);
      assert.equal(
        finalizedDirectInventory.availableQuantity,
        directBaseline.availableQuantity - 12,
      );
      assert.deepEqual(finalizedDirectInventory.shelves, [
        { shelf: 'B2', quantity: 98 },
      ]);

      const repeatDirectConfirm = await orderAction(
        `/orders/${directOrder._id}/admin-confirm`,
        tokens.admin,
      );
      assertStatus(repeatDirectConfirm, 200, 'repeat Admin confirmation');
      assert.match(repeatDirectConfirm.body.message, /already confirmed/i);
      assert.equal(repeatDirectConfirm.body.data.history.length, 2);
      assert.deepEqual(
        (await getOrderTransactions(directOrder._id)).map(({ type }) => type),
        [
          'ORDER_RESERVE',
          'ORDER_RESERVE',
          'ORDER_DEDUCT',
          'ORDER_DEDUCT',
        ],
      );

      const directRejectBaseline = await getInventory(mainVariant.variantId);
      const directRejectCreation = await createOrder(tokens.wholesalerA, [
        { variantId: mainVariant.variantId, quantity: 2 },
      ]);
      assertStatus(directRejectCreation, 201, 'direct order for Admin rejection');
      const directRejectOrder = directRejectCreation.body.data;

      const directWholesalerConfirm = await orderAction(
        `/orders/${directRejectOrder._id}/wholesaler-confirm`,
        tokens.wholesalerA,
      );
      assertStatus(
        directWholesalerConfirm,
        409,
        'direct Wholesaler order cannot use Wholesaler confirmation',
      );
      const directWholesalerReject = await orderAction(
        `/orders/${directRejectOrder._id}/wholesaler-reject`,
        tokens.wholesalerA,
        { reason: 'Invalid direct action' },
      );
      assertStatus(
        directWholesalerReject,
        409,
        'direct Wholesaler order cannot use Wholesaler rejection',
      );
      const directWholesalerAdjust = await orderAction(
        `/orders/${directRejectOrder._id}/wholesaler-adjust`,
        tokens.wholesalerA,
        {
          items: [
            {
              orderItemId: directRejectOrder.items[0]._id,
              quantity: 1,
            },
          ],
        },
        'PATCH',
      );
      assertStatus(
        directWholesalerAdjust,
        409,
        'direct Wholesaler order cannot use Wholesaler adjustment',
      );

      const rejectDirect = await orderAction(
        `/orders/${directRejectOrder._id}/admin-reject`,
        tokens.admin,
        { reason: 'Direct order rejected in integration test' },
      );
      assertStatus(rejectDirect, 200, 'Admin rejects Wholesaler order');
      assert.equal(rejectDirect.body.data.status, 'REJECTED');
      assert.equal(rejectDirect.body.data.inventoryStatus, 'RELEASED');
      assert.equal(rejectDirect.body.data.rejectedBy, 'admin');
      assert.equal(
        rejectDirect.body.data.rejectionReason,
        'Direct order rejected in integration test',
      );
      assert.deepEqual(
        rejectDirect.body.data.history.map(({ type }) => type),
        ['CREATED', 'ADMIN_REJECTED'],
      );

      const afterDirectReject = await getInventory(mainVariant.variantId);
      assert.equal(afterDirectReject.totalQuantity, directRejectBaseline.totalQuantity);
      assert.equal(
        afterDirectReject.availableQuantity,
        directRejectBaseline.availableQuantity,
      );
      assert.equal(afterDirectReject.reservedQuantity, 0);

      const repeatDirectReject = await orderAction(
        `/orders/${directRejectOrder._id}/admin-reject`,
        tokens.admin,
        { reason: 'A different repeated reason' },
      );
      assertStatus(repeatDirectReject, 200, 'repeat Admin rejection');
      assert.match(repeatDirectReject.body.message, /already rejected/i);
      assert.equal(repeatDirectReject.body.data.history.length, 2);
      assert.deepEqual(
        (await getOrderTransactions(directRejectOrder._id)).map(
          ({ type }) => type,
        ),
        ['ORDER_RESERVE', 'ORDER_RELEASE'],
      );

      const retailerConfirmBaseline = await getInventory(mainVariant.variantId);
      const retailerCreation = await createOrder(tokens.retailerA, [
        { variantId: mainVariant.variantId, quantity: 4 },
      ]);
      assertStatus(retailerCreation, 201, 'Retailer order creation');
      const retailerOrder = retailerCreation.body.data;
      assert.equal(retailerOrder.sourceRole, 'retailer');
      assert.equal(retailerOrder.status, 'PENDING_WHOLESALER');
      assert.equal(retailerOrder.placedBy._id, retailerA._id.toString());
      assert.equal(retailerOrder.retailer._id, retailerA._id.toString());
      assert.equal(retailerOrder.wholesaler._id, wholesalerA._id.toString());
      assert.equal(retailerOrder.items[0].discountPercent, 10);
      assert.equal(retailerOrder.items[0].unitPrice, 179.99);
      assert.equal(retailerOrder.subtotal, 799.96);
      assert.equal(retailerOrder.discountAmount, 80);
      assert.equal(retailerOrder.totalAmount, 719.96);

      const blockedParentDeactivation = await request(
        `/wholesalers/${wholesalerA._id}/status`,
        {
          method: 'PATCH',
          token: tokens.admin,
          body: { status: 'inactive' },
        },
      );
      assertStatus(
        blockedParentDeactivation,
        409,
        'Wholesaler with pending Retailer approval cannot be deactivated',
      );

      const parentRetailerList = await request('/orders?sourceRole=retailer', {
        token: tokens.wholesalerA,
      });
      assertStatus(parentRetailerList, 200, 'parent Wholesaler lists Retailer orders');
      assert.ok(
        parentRetailerList.body.data.orders.some(
          ({ _id }) => _id === retailerOrder._id,
        ),
      );

      const otherWholesalerList = await request('/orders', {
        token: tokens.wholesalerB,
      });
      assertStatus(otherWholesalerList, 200, 'other Wholesaler order list');
      assert.equal(
        otherWholesalerList.body.data.orders.some(
          ({ _id }) => _id === retailerOrder._id,
        ),
        false,
      );

      const crossWholesalerDetail = await request(
        `/orders/${retailerOrder._id}`,
        { token: tokens.wholesalerB },
      );
      assertStatus(crossWholesalerDetail, 404, 'cross-Wholesaler order detail');

      const crossRetailerDetail = await request(
        `/orders/${retailerOrder._id}`,
        { token: tokens.retailerB },
      );
      assertStatus(crossRetailerDetail, 404, 'cross-Retailer order detail');

      const retailerCannotSeeDirect = await request(`/orders/${directOrder._id}`, {
        token: tokens.retailerA,
      });
      assertStatus(retailerCannotSeeDirect, 404, 'Retailer cannot see direct order');

      const crossWholesalerConfirm = await orderAction(
        `/orders/${retailerOrder._id}/wholesaler-confirm`,
        tokens.wholesalerB,
      );
      assertStatus(crossWholesalerConfirm, 404, 'cross-Wholesaler confirmation');

      const retailerCannotApprove = await orderAction(
        `/orders/${retailerOrder._id}/wholesaler-confirm`,
        tokens.retailerA,
      );
      assertStatus(retailerCannotApprove, 403, 'Retailer cannot approve an order');

      const wholesalerConfirm = await orderAction(
        `/orders/${retailerOrder._id}/wholesaler-confirm`,
        tokens.wholesalerA,
      );
      assertStatus(wholesalerConfirm, 200, 'parent Wholesaler confirmation');
      assert.equal(wholesalerConfirm.body.data.status, 'PENDING_ADMIN');
      assert.deepEqual(
        wholesalerConfirm.body.data.history.map(({ type }) => type),
        ['CREATED', 'WHOLESALER_CONFIRMED'],
      );

      const repeatWholesalerConfirm = await orderAction(
        `/orders/${retailerOrder._id}/wholesaler-confirm`,
        tokens.wholesalerA,
      );
      assertStatus(
        repeatWholesalerConfirm,
        409,
        'repeat Wholesaler confirmation is safe',
      );

      const adminRetailerConfirm = await orderAction(
        `/orders/${retailerOrder._id}/admin-confirm`,
        tokens.admin,
      );
      assertStatus(adminRetailerConfirm, 200, 'Admin confirms Retailer order');
      assert.equal(adminRetailerConfirm.body.data.status, 'CONFIRMED');
      assert.deepEqual(
        adminRetailerConfirm.body.data.history.map(({ type }) => type),
        ['CREATED', 'WHOLESALER_CONFIRMED', 'ADMIN_CONFIRMED'],
      );
      const afterRetailerConfirm = await getInventory(mainVariant.variantId);
      assert.equal(
        afterRetailerConfirm.totalQuantity,
        retailerConfirmBaseline.totalQuantity - 4,
      );
      assert.equal(afterRetailerConfirm.reservedQuantity, 0);

      const retailerRejectBaseline = await getInventory(mainVariant.variantId);
      const retailerRejectCreation = await createOrder(tokens.retailerA, [
        { variantId: mainVariant.variantId, quantity: 2 },
      ]);
      assertStatus(retailerRejectCreation, 201, 'Retailer rejection order creation');
      const retailerRejectOrder = retailerRejectCreation.body.data;

      const crossWholesalerReject = await orderAction(
        `/orders/${retailerRejectOrder._id}/wholesaler-reject`,
        tokens.wholesalerB,
        { reason: 'Forbidden cross-account rejection' },
      );
      assertStatus(crossWholesalerReject, 404, 'cross-Wholesaler rejection');

      const wholesalerReject = await orderAction(
        `/orders/${retailerRejectOrder._id}/wholesaler-reject`,
        tokens.wholesalerA,
        { reason: 'Retailer quantities are unavailable' },
      );
      assertStatus(wholesalerReject, 200, 'parent Wholesaler rejection');
      assert.equal(wholesalerReject.body.data.status, 'REJECTED');
      assert.equal(wholesalerReject.body.data.rejectedBy, 'wholesaler');
      assert.deepEqual(
        wholesalerReject.body.data.history.map(({ type }) => type),
        ['CREATED', 'WHOLESALER_REJECTED'],
      );
      const afterWholesalerReject = await getInventory(mainVariant.variantId);
      assert.equal(
        afterWholesalerReject.availableQuantity,
        retailerRejectBaseline.availableQuantity,
      );
      assert.equal(afterWholesalerReject.reservedQuantity, 0);

      const repeatWholesalerReject = await orderAction(
        `/orders/${retailerRejectOrder._id}/wholesaler-reject`,
        tokens.wholesalerA,
        { reason: 'Repeated rejection' },
      );
      assertStatus(repeatWholesalerReject, 200, 'repeat Wholesaler rejection');
      assert.match(repeatWholesalerReject.body.message, /already rejected/i);
      assert.equal(repeatWholesalerReject.body.data.history.length, 2);

      const wholesalerAdjustBaseline = await getInventory(mainVariant.variantId);
      const wholesalerAdjustCreation = await createOrder(tokens.retailerA, [
        { variantId: mainVariant.variantId, quantity: 10 },
      ]);
      assertStatus(wholesalerAdjustCreation, 201, 'Wholesaler adjustment order');
      const wholesalerAdjustOrder = wholesalerAdjustCreation.body.data;
      const wholesalerAdjust = await orderAction(
        `/orders/${wholesalerAdjustOrder._id}/wholesaler-adjust`,
        tokens.wholesalerA,
        {
          items: [
            {
              orderItemId: wholesalerAdjustOrder.items[0]._id,
              quantity: 6,
            },
          ],
          note: 'Reduced to currently approved quantity',
        },
        'PATCH',
      );
      assertStatus(wholesalerAdjust, 200, 'Wholesaler decreases Retailer order');
      assert.equal(wholesalerAdjust.body.data.status, 'PENDING_WHOLESALER');
      assert.equal(wholesalerAdjust.body.data.totalPieces, 6);
      assert.equal(wholesalerAdjust.body.data.subtotal, 1199.94);
      assert.equal(wholesalerAdjust.body.data.discountAmount, 120);
      assert.equal(wholesalerAdjust.body.data.totalAmount, 1079.94);
      assert.equal(wholesalerAdjust.body.data.history.at(-1).type, 'WHOLESALER_ADJUSTED');
      assert.equal(
        wholesalerAdjust.body.data.history.at(-1).note,
        'Reduced to currently approved quantity',
      );
      assert.deepEqual(
        wholesalerAdjust.body.data.history.at(-1).itemChanges.map(
          ({ beforeQuantity, afterQuantity }) => ({
            beforeQuantity,
            afterQuantity,
          }),
        ),
        [{ beforeQuantity: 10, afterQuantity: 6 }],
      );
      const afterWholesalerAdjust = await getInventory(mainVariant.variantId);
      assert.equal(afterWholesalerAdjust.reservedQuantity, 6);
      assert.equal(
        afterWholesalerAdjust.availableQuantity,
        wholesalerAdjustBaseline.availableQuantity - 6,
      );

      const noOpWholesalerAdjust = await orderAction(
        `/orders/${wholesalerAdjustOrder._id}/wholesaler-adjust`,
        tokens.wholesalerA,
        {
          items: [
            {
              orderItemId: wholesalerAdjustOrder.items[0]._id,
              quantity: 6,
            },
          ],
        },
        'PATCH',
      );
      assertStatus(noOpWholesalerAdjust, 400, 'no-op Wholesaler adjustment');

      const removeOnlyItem = await orderAction(
        `/orders/${wholesalerAdjustOrder._id}/wholesaler-adjust`,
        tokens.wholesalerA,
        {
          items: [
            {
              orderItemId: wholesalerAdjustOrder.items[0]._id,
              quantity: 0,
            },
          ],
        },
        'PATCH',
      );
      assertStatus(removeOnlyItem, 400, 'cannot remove every order item');

      const confirmAdjustedRetailer = await orderAction(
        `/orders/${wholesalerAdjustOrder._id}/wholesaler-confirm`,
        tokens.wholesalerA,
      );
      assertStatus(confirmAdjustedRetailer, 200, 'confirm adjusted Retailer order');
      const rejectAdjustedRetailer = await orderAction(
        `/orders/${wholesalerAdjustOrder._id}/admin-reject`,
        tokens.admin,
        { reason: 'Cleanup adjusted Retailer order' },
      );
      assertStatus(rejectAdjustedRetailer, 200, 'release adjusted Retailer order');
      const afterAdjustedRelease = await getInventory(mainVariant.variantId);
      assert.equal(afterAdjustedRelease.reservedQuantity, 0);
      assert.equal(
        afterAdjustedRelease.availableQuantity,
        wholesalerAdjustBaseline.availableQuantity,
      );

      const adminAdjustMainBaseline = await getInventory(mainVariant.variantId);
      const adminAdjustSecondaryBaseline = await getInventory(
        secondaryVariant.variantId,
      );
      const adminAdjustCreation = await createOrder(tokens.wholesalerA, [
        { variantId: secondaryVariant.variantId, quantity: 2 },
        { variantId: mainVariant.variantId, quantity: 1 },
      ]);
      assertStatus(adminAdjustCreation, 201, 'Admin adjustment order creation');
      const adminAdjustOrder = adminAdjustCreation.body.data;
      const secondaryOrderItem = adminAdjustOrder.items.find(
        ({ variantId }) => variantId === secondaryVariant.variantId.toString(),
      );
      const mainOrderItem = adminAdjustOrder.items.find(
        ({ variantId }) => variantId === mainVariant.variantId.toString(),
      );

      const wholesalerCannotAdminAdjust = await orderAction(
        `/orders/${adminAdjustOrder._id}/admin-adjust`,
        tokens.wholesalerA,
        {
          items: [{ orderItemId: secondaryOrderItem._id, quantity: 5 }],
        },
        'PATCH',
      );
      assertStatus(wholesalerCannotAdminAdjust, 403, 'Wholesaler cannot Admin-adjust');

      const adminAdjust = await orderAction(
        `/orders/${adminAdjustOrder._id}/admin-adjust`,
        tokens.admin,
        {
          items: [
            { orderItemId: secondaryOrderItem._id, quantity: 5 },
            { orderItemId: mainOrderItem._id, quantity: 0 },
          ],
          note: 'Increase Navy and remove Black',
        },
        'PATCH',
      );
      assertStatus(adminAdjust, 200, 'Admin adjusts quantities and removes item');
      assert.equal(adminAdjust.body.data.status, 'PENDING_ADMIN');
      assert.equal(adminAdjust.body.data.items.length, 2);
      const adjustedActiveItem = adminAdjust.body.data.items.find(
        ({ isRemoved }) => !isRemoved,
      );
      const adjustedRemovedItem = adminAdjust.body.data.items.find(
        ({ isRemoved }) => isRemoved,
      );
      assert.equal(
        adjustedActiveItem.variantId,
        secondaryVariant.variantId.toString(),
      );
      assert.equal(
        adjustedRemovedItem.variantId,
        mainVariant.variantId.toString(),
      );
      assert.equal(adjustedRemovedItem.quantity, 0);
      assert.equal(adjustedRemovedItem.basePrice, 199.99);
      assert.equal(adjustedRemovedItem.lineSubtotal, 0);
      assert.equal(adjustedRemovedItem.lineTotal, 0);
      assert.equal(adminAdjust.body.data.totalPieces, 5);
      assert.equal(adminAdjust.body.data.subtotal, 999.95);
      assert.equal(adminAdjust.body.data.discountAmount, 125);
      assert.equal(adminAdjust.body.data.totalAmount, 874.95);
      assert.equal(adminAdjust.body.data.history.at(-1).type, 'ADMIN_ADJUSTED');
      assert.deepEqual(
        adminAdjust.body.data.history.at(-1).itemChanges
          .map(({ beforeQuantity, afterQuantity }) => ({
            beforeQuantity,
            afterQuantity,
          }))
          .sort((left, right) => left.afterQuantity - right.afterQuantity),
        [
          { beforeQuantity: 1, afterQuantity: 0 },
          { beforeQuantity: 2, afterQuantity: 5 },
        ],
      );

      const afterAdminAdjustMain = await getInventory(mainVariant.variantId);
      const afterAdminAdjustSecondary = await getInventory(
        secondaryVariant.variantId,
      );
      assert.equal(afterAdminAdjustMain.reservedQuantity, 0);
      assert.equal(
        afterAdminAdjustMain.availableQuantity,
        adminAdjustMainBaseline.availableQuantity,
      );
      assert.equal(afterAdminAdjustSecondary.reservedQuantity, 5);
      assert.equal(
        afterAdminAdjustSecondary.availableQuantity,
        adminAdjustSecondaryBaseline.availableQuantity - 5,
      );

      const confirmAdminAdjusted = await orderAction(
        `/orders/${adminAdjustOrder._id}/admin-confirm`,
        tokens.admin,
      );
      assertStatus(confirmAdminAdjusted, 200, 'Admin confirms adjusted order');
      assert.deepEqual(
        confirmAdminAdjusted.body.data.history.map(({ type }) => type),
        ['CREATED', 'ADMIN_ADJUSTED', 'ADMIN_CONFIRMED'],
      );
      const afterAdminAdjustedConfirm = await getInventory(
        secondaryVariant.variantId,
      );
      assert.equal(
        afterAdminAdjustedConfirm.totalQuantity,
        adminAdjustSecondaryBaseline.totalQuantity - 5,
      );
      assert.equal(afterAdminAdjustedConfirm.reservedQuantity, 0);

      const betaFilterCreation = await createOrder(tokens.wholesalerB, [
        { variantId: mainVariant.variantId, quantity: 1 },
      ]);
      assertStatus(betaFilterCreation, 201, 'Beta Wholesaler filter fixture');
      const betaOrder = betaFilterCreation.body.data;

      const adminFilteredRetailerOrders = await request(
        `/orders?status=CONFIRMED&sourceRole=retailer&wholesalerId=${wholesalerA._id}&retailerId=${retailerA._id}`,
        { token: tokens.admin },
      );
      assertStatus(adminFilteredRetailerOrders, 200, 'Admin order filters');
      assert.ok(adminFilteredRetailerOrders.body.data.pagination.total >= 1);
      assert.ok(
        adminFilteredRetailerOrders.body.data.orders.every(
          (order) =>
            order.status === 'CONFIRMED' &&
            order.sourceRole === 'retailer' &&
            order.wholesaler._id === wholesalerA._id.toString() &&
            order.retailer._id === retailerA._id.toString(),
        ),
      );

      const betaCannotWidenScope = await request(
        `/orders?wholesalerId=${wholesalerA._id}`,
        { token: tokens.wholesalerB },
      );
      assertStatus(betaCannotWidenScope, 200, 'Wholesaler filter cannot widen scope');
      assert.ok(betaCannotWidenScope.body.data.orders.length >= 1);
      assert.ok(
        betaCannotWidenScope.body.data.orders.every(
          (order) => order.wholesaler._id === wholesalerB._id.toString(),
        ),
      );

      const retailerCannotWidenScope = await request(
        `/orders?retailerId=${retailerB._id}`,
        { token: tokens.retailerA },
      );
      assertStatus(retailerCannotWidenScope, 200, 'Retailer filter cannot widen scope');
      assert.ok(
        retailerCannotWidenScope.body.data.orders.every(
          (order) => order.retailer._id === retailerA._id.toString(),
        ),
      );

      const searchByOrderNumber = await request(
        `/orders?search=${encodeURIComponent(directOrder.orderNumber)}`,
        { token: tokens.admin },
      );
      assertStatus(searchByOrderNumber, 200, 'order number search');
      assert.equal(searchByOrderNumber.body.data.pagination.total, 1);
      assert.equal(searchByOrderNumber.body.data.orders[0]._id, directOrder._id);

      const today = new Date().toISOString().slice(0, 10);
      const dateFiltered = await request(
        `/orders?dateFrom=${today}&dateTo=${today}&page=1&limit=100`,
        { token: tokens.admin },
      );
      assertStatus(dateFiltered, 200, 'date and pagination filters');
      assert.ok(dateFiltered.body.data.pagination.total >= 1);
      assert.ok(dateFiltered.body.data.orders.length <= 100);

      const invalidStatusFilter = await request('/orders?status=UNKNOWN', {
        token: tokens.admin,
      });
      assertStatus(invalidStatusFilter, 400, 'invalid order status filter');

      const impossibleCalendarDate = await request(
        '/orders?dateFrom=2026-02-31',
        { token: tokens.admin },
      );
      assertStatus(
        impossibleCalendarDate,
        400,
        'impossible calendar date filter',
      );

      const betaCleanup = await orderAction(
        `/orders/${betaOrder._id}/admin-reject`,
        tokens.admin,
        { reason: 'Cleanup Beta filter fixture' },
      );
      assertStatus(betaCleanup, 200, 'cleanup Beta order reservation');

      await User.updateOne(
        { _id: retailerA._id },
        { $set: { status: 'inactive' } },
      );
      const inactiveRetailerOrder = await createOrder(tokens.retailerA, [
        { variantId: mainVariant.variantId, quantity: 1 },
      ]);
      assertStatus(inactiveRetailerOrder, 401, 'inactive Retailer cannot order');
      await User.updateOne(
        { _id: retailerA._id },
        { $set: { status: 'active' } },
      );

      await User.updateOne(
        { _id: wholesalerA._id },
        { $set: { status: 'inactive' } },
      );
      const inactiveWholesalerOrder = await createOrder(tokens.wholesalerA, [
        { variantId: mainVariant.variantId, quantity: 1 },
      ]);
      assertStatus(inactiveWholesalerOrder, 401, 'inactive Wholesaler cannot order');
      const retailerWithInactiveParent = await createOrder(tokens.retailerA, [
        { variantId: mainVariant.variantId, quantity: 1 },
      ]);
      assertStatus(
        retailerWithInactiveParent,
        401,
        'Retailer under inactive Wholesaler cannot order',
      );
      await User.updateOne(
        { _id: wholesalerA._id },
        { $set: { status: 'active' } },
      );

      const concurrencyResponses = await Promise.all([
        createOrder(tokens.wholesalerA, [
          { variantId: concurrencyVariant.variantId, quantity: 4 },
        ]),
        createOrder(tokens.wholesalerB, [
          { variantId: concurrencyVariant.variantId, quantity: 4 },
        ]),
      ]);
      assert.deepEqual(
        concurrencyResponses.map(({ status }) => status).sort(),
        [201, 409],
        `concurrent reservation responses: ${JSON.stringify(
          concurrencyResponses.map(({ status, body }) => ({ status, body })),
        )}`,
      );
      const concurrencyInventory = await getInventory(
        concurrencyVariant.variantId,
      );
      assert.equal(concurrencyInventory.totalQuantity, 5);
      assert.equal(concurrencyInventory.reservedQuantity, 4);
      assert.equal(concurrencyInventory.availableQuantity, 1);
      assert.deepEqual(concurrencyInventory.reservedShelves, [
        { shelf: 'Q1', quantity: 4 },
      ]);
      const concurrencyWinner = concurrencyResponses.find(
        ({ status }) => status === 201,
      ).body.data;
      const concurrencyOrders = await Order.countDocuments({
        'items.variantId': concurrencyVariant.variantId,
      });
      assert.equal(concurrencyOrders, 1);

      const concurrencyCleanup = await orderAction(
        `/orders/${concurrencyWinner._id}/admin-reject`,
        tokens.admin,
        { reason: 'Cleanup concurrency fixture' },
      );
      assertStatus(concurrencyCleanup, 200, 'release concurrency winner');
      const concurrencyReleasedInventory = await getInventory(
        concurrencyVariant.variantId,
      );
      assert.equal(concurrencyReleasedInventory.totalQuantity, 5);
      assert.equal(concurrencyReleasedInventory.reservedQuantity, 0);
      assert.equal(concurrencyReleasedInventory.availableQuantity, 5);

      const orderNumbers = await Order.distinct('orderNumber');
      assert.equal(orderNumbers.length, await Order.countDocuments());
      assert.ok(orderNumbers.every((number) => /^JB-\d{8}-\d{6,12}$/.test(number)));

      const finalMainInventory = await request(
        `/inventory/${mainVariant.variantId}`,
        { token: tokens.admin },
      );
      const finalCatalog = await request(`/products/${catalog.product._id}`, {
        token: tokens.admin,
      });
      const finalHealth = await request('/health');
      assertStatus(finalMainInventory, 200, 'final Inventory regression smoke');
      assertStatus(finalCatalog, 200, 'final Catalog regression smoke');
      assertStatus(finalHealth, 200, 'final Health regression smoke');
    } finally {
      if (server) {
        await closeServer(server);
      }

      if (mongoose.connection.readyState !== 0) {
        await mongoose.connection.dropDatabase();
        await mongoose.disconnect();
      }
    }
  },
);
