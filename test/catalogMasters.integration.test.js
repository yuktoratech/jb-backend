const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');

const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.JWT_EXPIRES_IN = '1h';

const TEST_DATABASE_URI =
  process.env.CATALOG_MASTERS_TEST_MONGODB_URI ||
  'mongodb://127.0.0.1:27017/jb_b2b_catalog_masters_test';
const databaseName = new URL(TEST_DATABASE_URI).pathname.slice(1);

if (!/^jb_b2b_catalog_masters_test(?:_|$)/.test(databaseName)) {
  throw new Error(
    'CATALOG_MASTERS_TEST_MONGODB_URI must target a jb_b2b_catalog_masters_test database',
  );
}

const app = require('../src/app');
const SizeSet = require('../src/modules/sizeSets/sizeSet.model');
const User = require('../src/modules/users/user.model');

const closeServer = (server) =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

test(
  'dynamic catalog masters enforce normalization, ownership, and SizeSet invariants',
  { timeout: 60000 },
  async () => {
    let server;

    try {
      await mongoose.connect(TEST_DATABASE_URI);
      await mongoose.connection.dropDatabase();

      const adminPassword = `Admin-${crypto.randomBytes(24).toString('base64url')}`;
      const wholesalerPassword = `Wholesale-${crypto.randomBytes(24).toString('base64url')}`;
      const [admin, wholesaler] = await User.create([
        {
          name: 'Catalog Admin',
          email: 'catalog.admin@example.test',
          password: adminPassword,
          role: 'admin',
          status: 'active',
        },
        {
          name: 'Catalog Wholesaler',
          email: 'catalog.wholesaler@example.test',
          password: wholesalerPassword,
          role: 'wholesaler',
          status: 'active',
        },
      ]);

      server = app.listen(0, '127.0.0.1');
      await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
      const request = async (path, { method = 'GET', token, body } = {}) => {
        const headers = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const response = await fetch(`${baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      };
      const login = async (email, password) => {
        const result = await request('/auth/login', {
          method: 'POST',
          body: { email, password },
        });
        assert.equal(result.status, 200);
        return result.body.data.accessToken;
      };
      const adminToken = await login(admin.email, adminPassword);
      const wholesalerToken = await login(wholesaler.email, wholesalerPassword);

      const firstCategory = await request('/categories', {
        method: 'POST',
        token: adminToken,
        body: { name: '  Shirts  ' },
      });
      assert.equal(firstCategory.status, 201);
      const secondCategory = await request('/categories', {
        method: 'POST',
        token: adminToken,
        body: { name: 'Denim' },
      });
      assert.equal(secondCategory.status, 201);

      const subCategory = await request('/subcategories', {
        method: 'POST',
        token: adminToken,
        body: {
          categoryId: firstCategory.body.data._id,
          name: '  Plain   Solid  ',
        },
      });
      assert.equal(subCategory.status, 201);
      assert.equal(subCategory.body.data.name, 'Plain Solid');
      assert.equal(subCategory.body.data.slug, 'plain-solid');
      assert.equal(subCategory.body.data.category._id, firstCategory.body.data._id);
      assert.ok(subCategory.body.data.createdAt);
      assert.ok(subCategory.body.data.updatedAt);

      const duplicateInCategory = await request('/subcategories', {
        method: 'POST',
        token: adminToken,
        body: { categoryId: firstCategory.body.data._id, name: 'plain solid' },
      });
      assert.equal(duplicateInCategory.status, 409);

      const sameNameOtherCategory = await request('/subcategories', {
        method: 'POST',
        token: adminToken,
        body: { categoryId: secondCategory.body.data._id, name: 'Plain Solid' },
      });
      assert.equal(sameNameOtherCategory.status, 201);

      await request(`/categories/${secondCategory.body.data._id}`, {
        method: 'DELETE',
        token: adminToken,
      });
      const inactiveParent = await request('/subcategories', {
        method: 'POST',
        token: adminToken,
        body: { categoryId: secondCategory.body.data._id, name: 'Cargo' },
      });
      assert.equal(inactiveParent.status, 404);

      const simpleMasters = [
        ['/colours', 'Jet Black'],
        ['/fits', 'Relaxed Fit'],
        ['/fabrics', 'Cotton Twill'],
      ];

      for (const [path, name] of simpleMasters) {
        const created = await request(path, {
          method: 'POST',
          token: adminToken,
          body: { name: `  ${name}  ` },
        });
        assert.equal(created.status, 201);
        assert.equal(created.body.data.name, name);
        assert.equal(created.body.data.slug, name.toLowerCase().replace(/ /g, '-'));

        const readableByWholesaler = await request(path, { token: wholesalerToken });
        assert.equal(readableByWholesaler.status, 200);
        assert.equal(readableByWholesaler.body.data.pagination.total, 1);

        const forbiddenWrite = await request(path, {
          method: 'POST',
          token: wholesalerToken,
          body: { name: `${name} Forbidden` },
        });
        assert.equal(forbiddenWrite.status, 403);

        const duplicate = await request(path, {
          method: 'POST',
          token: adminToken,
          body: { name: name.toUpperCase() },
        });
        assert.equal(duplicate.status, 409);

        const deactivated = await request(`${path}/${created.body.data._id}`, {
          method: 'DELETE',
          token: adminToken,
        });
        assert.equal(deactivated.status, 200);
        assert.equal(deactivated.body.data.status, 'inactive');
      }

      const clientPieceCount = await request('/size-sets', {
        method: 'POST',
        token: adminToken,
        body: { label: 'Invalid', sizes: ['S'], pieceCount: 99 },
      });
      assert.equal(clientPieceCount.status, 400);

      const sizeSet = await request('/size-sets', {
        method: 'POST',
        token: adminToken,
        body: { label: '  S - XXL  ', sizes: [' S ', 'M', ' XXL '] },
      });
      assert.equal(sizeSet.status, 201);
      assert.equal(sizeSet.body.data.label, 'S - XXL');
      assert.deepEqual(sizeSet.body.data.sizes, ['S', 'M', 'XXL']);
      assert.equal(sizeSet.body.data.pieceCount, 3);

      const duplicateSizes = await request('/size-sets', {
        method: 'POST',
        token: adminToken,
        body: { label: 'Duplicate', sizes: ['M', ' m '] },
      });
      assert.equal(duplicateSizes.status, 400);

      const emptySizes = await request('/size-sets', {
        method: 'POST',
        token: adminToken,
        body: { label: 'Empty', sizes: [] },
      });
      assert.equal(emptySizes.status, 400);

      const updatedSizeSet = await request(`/size-sets/${sizeSet.body.data._id}`, {
        method: 'PATCH',
        token: adminToken,
        body: { sizes: ['L', 'XL'] },
      });
      assert.equal(updatedSizeSet.status, 200);
      assert.deepEqual(updatedSizeSet.body.data.sizes, ['L', 'XL']);
      assert.equal(updatedSizeSet.body.data.pieceCount, 2);

      const modelDerived = await SizeSet.create({
        label: 'Model Derived',
        sizes: ['30', '32', '34'],
        pieceCount: 999,
      });
      assert.equal(modelDerived.pieceCount, 3);

      const forbiddenSizeSetUpdate = await request(`/size-sets/${sizeSet.body.data._id}`, {
        method: 'PATCH',
        token: wholesalerToken,
        body: { status: 'inactive' },
      });
      assert.equal(forbiddenSizeSetUpdate.status, 403);

      const deactivatedSubCategory = await request(
        `/subcategories/${subCategory.body.data._id}`,
        { method: 'DELETE', token: adminToken },
      );
      assert.equal(deactivatedSubCategory.status, 200);
      assert.equal(deactivatedSubCategory.body.data.status, 'inactive');
    } finally {
      if (server) await closeServer(server);
      if (mongoose.connection.readyState !== 0) {
        await mongoose.connection.dropDatabase();
        await mongoose.disconnect();
      }
    }
  },
);
