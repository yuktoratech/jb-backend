const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');

const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.JWT_EXPIRES_IN = '1h';

const TEST_DATABASE_URI =
  process.env.ACCOUNTS_TEST_MONGODB_URI ||
  'mongodb://127.0.0.1:27017/jb_b2b_accounts_test';
const databaseName = new URL(TEST_DATABASE_URI).pathname.slice(1);

if (!/^jb_b2b_accounts_test(?:_|$)/.test(databaseName)) {
  throw new Error(
    'ACCOUNTS_TEST_MONGODB_URI must target a jb_b2b_accounts_test database',
  );
}

const app = require('../src/app');
const Inventory = require('../src/modules/inventory/inventory.model');
const User = require('../src/modules/users/user.model');

const closeServer = (server) =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

const assertNoPasswordData = (value) => {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes('"password"'), false);
  assert.equal(serialized.includes('temporaryPassword'), false);
  assert.equal(serialized.includes('$2a$'), false);
  assert.equal(serialized.includes('$2b$'), false);
};

test(
  'admin and wholesaler account hierarchy is enforced end to end',
  { timeout: 60000 },
  async () => {
    let server;

    try {
      await mongoose.connect(TEST_DATABASE_URI);
      await mongoose.connection.dropDatabase();

      const adminPassword = `Admin-${crypto.randomBytes(24).toString('base64url')}`;
      const admin = await User.create({
        name: 'Accounts Admin',
        email: 'accounts.admin@example.test',
        password: adminPassword,
        role: 'admin',
        status: 'active',
        isEmailVerified: true,
      });

      server = app.listen(0, '127.0.0.1');
      await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });

      const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
      const request = async (
        path,
        { method = 'GET', token, body } = {},
      ) => {
        const headers = {};

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
      const login = (email, password) =>
        request('/auth/login', {
          method: 'POST',
          body: { email, password },
        });

      const health = await request('/health');
      assert.equal(health.status, 200);
      assert.equal(health.body.success, true);

      const adminLogin = await login(admin.email, adminPassword);
      assert.equal(adminLogin.status, 200);
      assert.equal(adminLogin.body.data.user.role, 'admin');
      const adminToken = adminLogin.body.data.accessToken;

      const createWholesaler = (body, token = adminToken) =>
        request('/wholesalers', {
          method: 'POST',
          token,
          body,
        });

      const wholesalerACreation = await createWholesaler({
        name: 'Alpha Wholesale',
        email: 'alpha.wholesale@example.test',
        phone: '98765 43210',
        discountPercent: 10,
      });
      assert.equal(wholesalerACreation.status, 201);
      assert.equal(wholesalerACreation.body.data.user.role, 'wholesaler');
      assert.equal(wholesalerACreation.body.data.user.status, 'active');
      assert.equal(wholesalerACreation.body.data.user.discountPercent, 10);
      assert.equal(wholesalerACreation.body.data.user.phone, '9876543210');
      assert.equal(wholesalerACreation.body.data.user.parentWholesaler, null);
      assert.equal(
        wholesalerACreation.body.data.temporaryPassword.length,
        16,
      );

      const wholesalerA = wholesalerACreation.body.data.user;
      const wholesalerAPassword =
        wholesalerACreation.body.data.temporaryPassword;
      const storedWholesalerA = await User.findById(wholesalerA._id)
        .select('+password')
        .lean();
      assert.notEqual(storedWholesalerA.password, wholesalerAPassword);
      assert.match(storedWholesalerA.password, /^\$2[aby]\$/);

      const wholesalerALogin = await login(
        wholesalerA.email,
        wholesalerAPassword,
      );
      assert.equal(wholesalerALogin.status, 200);
      assert.equal(wholesalerALogin.body.data.user.role, 'wholesaler');
      const wholesalerAToken = wholesalerALogin.body.data.accessToken;

      const wholesalerBCreation = await createWholesaler({
        name: 'Beta Wholesale',
        email: 'beta.wholesale@example.test',
        phone: '+919876543211',
        discountPercent: 15,
      });
      assert.equal(wholesalerBCreation.status, 201);
      const wholesalerB = wholesalerBCreation.body.data.user;
      const wholesalerBLogin = await login(
        wholesalerB.email,
        wholesalerBCreation.body.data.temporaryPassword,
      );
      assert.equal(wholesalerBLogin.status, 200);
      const wholesalerBToken = wholesalerBLogin.body.data.accessToken;

      const createRetailer = (body, token) =>
        request('/retailers', {
          method: 'POST',
          token,
          body,
        });

      const retailerACreation = await createRetailer(
        {
          name: 'Alpha Retail',
          email: 'alpha.retail@example.test',
          phone: '99999-99999',
          discountPercent: 5,
        },
        wholesalerAToken,
      );
      assert.equal(retailerACreation.status, 201);
      assert.equal(retailerACreation.body.data.user.role, 'retailer');
      assert.equal(retailerACreation.body.data.user.status, 'active');
      assert.equal(retailerACreation.body.data.user.discountPercent, 5);
      assert.equal(
        retailerACreation.body.data.user.parentWholesaler._id,
        wholesalerA._id,
      );
      const retailerA = retailerACreation.body.data.user;
      const retailerAPassword = retailerACreation.body.data.temporaryPassword;

      const retailerALogin = await login(retailerA.email, retailerAPassword);
      assert.equal(retailerALogin.status, 200);
      assert.equal(retailerALogin.body.data.user.role, 'retailer');
      assert.equal(
        retailerALogin.body.data.user.parentWholesaler,
        wholesalerA._id,
      );
      const retailerAToken = retailerALogin.body.data.accessToken;

      const retailerBCreation = await createRetailer(
        {
          name: 'Beta Retail',
          email: 'beta.retail@example.test',
          phone: '98888-88888',
          discountPercent: 8,
        },
        wholesalerBToken,
      );
      assert.equal(retailerBCreation.status, 201);
      const retailerB = retailerBCreation.body.data.user;

      const crossWholesalerRead = await request(
        `/retailers/${retailerB._id}`,
        { token: wholesalerAToken },
      );
      assert.equal(crossWholesalerRead.status, 404);

      const crossWholesalerUpdate = await request(
        `/retailers/${retailerB._id}`,
        {
          method: 'PATCH',
          token: wholesalerAToken,
          body: { discountPercent: 99 },
        },
      );
      assert.equal(crossWholesalerUpdate.status, 404);

      const wholesalerAList = await request('/retailers', {
        token: wholesalerAToken,
      });
      assert.equal(wholesalerAList.status, 200);
      assert.equal(wholesalerAList.body.data.pagination.total, 1);
      assert.equal(
        wholesalerAList.body.data.retailers[0]._id,
        retailerA._id,
      );
      assertNoPasswordData(wholesalerAList.body);

      const ignoredForeignScope = await request(
        `/retailers?wholesalerId=${wholesalerB._id}`,
        { token: wholesalerAToken },
      );
      assert.equal(ignoredForeignScope.status, 200);
      assert.equal(ignoredForeignScope.body.data.pagination.total, 1);
      assert.equal(
        ignoredForeignScope.body.data.retailers[0]._id,
        retailerA._id,
      );

      const wholesalerCannotCreateWholesaler = await createWholesaler(
        {
          name: 'Forbidden Wholesale',
          email: 'forbidden.wholesale@example.test',
        },
        wholesalerAToken,
      );
      assert.equal(wholesalerCannotCreateWholesaler.status, 403);

      const retailerCannotCreateRetailer = await createRetailer(
        {
          name: 'Forbidden Retail',
          email: 'forbidden.retail@example.test',
        },
        retailerAToken,
      );
      assert.equal(retailerCannotCreateRetailer.status, 403);

      const adminCannotCreateRetailer = await createRetailer(
        {
          name: 'Admin Retail',
          email: 'admin.retail@example.test',
        },
        adminToken,
      );
      assert.equal(adminCannotCreateRetailer.status, 403);

      const retailerCannotAccessAdminApi = await request('/categories', {
        token: retailerAToken,
      });
      assert.equal(retailerCannotAccessAdminApi.status, 403);

      const wholesalersList = await request('/wholesalers', {
        token: adminToken,
      });
      assert.equal(wholesalersList.status, 200);
      assert.equal(wholesalersList.body.data.pagination.total, 2);
      assert.equal(
        wholesalersList.body.data.wholesalers.find(
          ({ _id }) => _id === wholesalerA._id,
        ).retailerCount,
        1,
      );
      assertNoPasswordData(wholesalersList.body);

      const adminRetailerFilter = await request(
        `/retailers?wholesalerId=${wholesalerA._id}`,
        { token: adminToken },
      );
      assert.equal(adminRetailerFilter.status, 200);
      assert.equal(adminRetailerFilter.body.data.pagination.total, 1);
      assert.equal(
        adminRetailerFilter.body.data.retailers[0].parentWholesaler._id,
        wholesalerA._id,
      );
      assertNoPasswordData(adminRetailerFilter.body);

      const retailerUpdate = await request(`/retailers/${retailerA._id}`, {
        method: 'PATCH',
        token: wholesalerAToken,
        body: { discountPercent: 7, phone: null },
      });
      assert.equal(retailerUpdate.status, 200);
      assert.equal(retailerUpdate.body.data.discountPercent, 7);
      assert.equal(retailerUpdate.body.data.phone, undefined);
      assert.equal(
        retailerUpdate.body.data.parentWholesaler._id,
        wholesalerA._id,
      );

      const forbiddenParentSubmission = await createRetailer(
        {
          name: 'Invalid Parent Retail',
          email: 'invalid.parent@example.test',
          parentWholesaler: wholesalerB._id,
        },
        wholesalerAToken,
      );
      assert.equal(forbiddenParentSubmission.status, 400);

      const forbiddenRoleSubmission = await createWholesaler({
        name: 'Invalid Role Wholesale',
        email: 'invalid.role@example.test',
        role: 'admin',
      });
      assert.equal(forbiddenRoleSubmission.status, 400);

      const duplicateEmail = await createWholesaler({
        name: 'Duplicate Account',
        email: retailerA.email,
        phone: '97777-77777',
      });
      assert.equal(duplicateEmail.status, 409);

      const wholesalerUpdate = await request(
        `/wholesalers/${wholesalerA._id}`,
        {
          method: 'PATCH',
          token: adminToken,
          body: {
            name: 'Alpha Wholesale Updated',
            phone: null,
            discountPercent: 12,
          },
        },
      );
      assert.equal(wholesalerUpdate.status, 200);
      assert.equal(wholesalerUpdate.body.data.name, 'Alpha Wholesale Updated');
      assert.equal(wholesalerUpdate.body.data.discountPercent, 12);
      assert.equal(wholesalerUpdate.body.data.phone, undefined);

      const deactivateWholesaler = await request(
        `/wholesalers/${wholesalerA._id}/status`,
        {
          method: 'PATCH',
          token: adminToken,
          body: { status: 'inactive' },
        },
      );
      assert.equal(deactivateWholesaler.status, 200);

      const inactiveWholesalerLogin = await login(
        wholesalerA.email,
        wholesalerAPassword,
      );
      assert.equal(inactiveWholesalerLogin.status, 401);

      const inactiveWholesalerAccess = await request('/retailers', {
        token: wholesalerAToken,
      });
      assert.equal(inactiveWholesalerAccess.status, 401);

      const retailerUnderInactiveWholesalerLogin = await login(
        retailerA.email,
        retailerAPassword,
      );
      assert.equal(retailerUnderInactiveWholesalerLogin.status, 401);

      const retailerUnderInactiveWholesalerAccess = await request('/auth/me', {
        token: retailerAToken,
      });
      assert.equal(retailerUnderInactiveWholesalerAccess.status, 401);

      const reactivateWholesaler = await request(
        `/wholesalers/${wholesalerA._id}/status`,
        {
          method: 'PATCH',
          token: adminToken,
          body: { status: 'active' },
        },
      );
      assert.equal(reactivateWholesaler.status, 200);

      const deactivateRetailer = await request(
        `/retailers/${retailerA._id}/status`,
        {
          method: 'PATCH',
          token: wholesalerAToken,
          body: { status: 'inactive' },
        },
      );
      assert.equal(deactivateRetailer.status, 200);

      const inactiveRetailerLogin = await login(
        retailerA.email,
        retailerAPassword,
      );
      assert.equal(inactiveRetailerLogin.status, 401);

      const inactiveRetailerAccess = await request('/auth/me', {
        token: retailerAToken,
      });
      assert.equal(inactiveRetailerAccess.status, 401);

      const wholesalerDetail = await request(
        `/wholesalers/${wholesalerA._id}`,
        { token: adminToken },
      );
      const retailerDetail = await request(`/retailers/${retailerA._id}`, {
        token: adminToken,
      });
      assert.equal(wholesalerDetail.status, 200);
      assert.equal(retailerDetail.status, 200);
      assertNoPasswordData(wholesalerDetail.body);
      assertNoPasswordData(retailerDetail.body);

      const categoryCreation = await request('/categories', {
        method: 'POST',
        token: adminToken,
        body: {
          name: 'Accounts Regression Category',
          description: 'Created by account integration regression coverage',
        },
      });
      assert.equal(categoryCreation.status, 201);

      const subCategoryCreation = await request('/subcategories', {
        method: 'POST', token: adminToken,
        body: { name: 'Shirts', categoryId: categoryCreation.body.data._id },
      });
      const colourCreation = await request('/colours', {
        method: 'POST', token: adminToken, body: { name: 'Black' },
      });
      const fitCreation = await request('/fits', {
        method: 'POST', token: adminToken, body: { name: 'Regular' },
      });
      const fabricCreation = await request('/fabrics', {
        method: 'POST', token: adminToken, body: { name: 'Cotton' },
      });
      const sizeSetCreation = await request('/size-sets', {
        method: 'POST', token: adminToken,
        body: { label: '30-38', sizes: ['30', '32', '34', '36', '38'] },
      });

      const productCreation = await request('/products', {
        method: 'POST',
        token: adminToken,
        body: {
          name: 'Account Test Shirt',
          categoryId: categoryCreation.body.data._id,
          subCategoryId: subCategoryCreation.body.data._id,
          fitId: fitCreation.body.data._id,
          fabricId: fabricCreation.body.data._id,
          mrpPerPieceMinor: 10000,
          productColours: [{
            colourId: colourCreation.body.data._id,
            productCode: 'account test',
            skus: [{ sizeSetId: sizeSetCreation.body.data._id }],
          }],
        },
      });
      assert.equal(productCreation.status, 201);

      const product = productCreation.body.data.product;
      const variant = productCreation.body.data.productColours[0].skus[0];
      const variantId = variant._id;
      const initializedInventory = await Inventory.findOne({
        variant: variantId,
      }).lean();
      assert.ok(initializedInventory);
      assert.equal(initializedInventory.availableQuantity, 0);

      const variants = await request(`/products/${product._id}/variants`, {
        token: adminToken,
      });
      assert.equal(variants.status, 200);

      const adjustment = await request('/inventory/adjust', {
        method: 'POST',
        token: adminToken,
        body: {
          sku: variant.sku,
          type: 'ADD',
          quantity: 2,
          shelf: 'A1',
        },
      });
      assert.equal(adjustment.status, 200);
      assert.equal(adjustment.body.data.inventory.availableQuantity, 2);

      const inventoryBySku = await request(`/inventory/sku/${variant.sku}`, {
        token: adminToken,
      });
      const products = await request('/products', { token: adminToken });
      const categories = await request('/categories', { token: adminToken });
      assert.equal(inventoryBySku.status, 200);
      assert.equal(products.status, 200);
      assert.equal(categories.status, 200);

      const persistedAdmin = await User.findById(admin._id).lean();
      assert.equal(persistedAdmin.parentWholesaler, null);
      assert.equal(persistedAdmin.discountPercent, 0);
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
