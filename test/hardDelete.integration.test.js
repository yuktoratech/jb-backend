const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.JWT_EXPIRES_IN = '1h';
const URI = process.env.HARD_DELETE_TEST_MONGODB_URI;

const app = require('../src/app');
const storage = require('../src/storage/objectStorage.service');
const Address = require('../src/modules/addresses/address.model');
const Category = require('../src/modules/categories/category.model');
const Colour = require('../src/modules/colours/colour.model');
const Fabric = require('../src/modules/fabrics/fabric.model');
const Fit = require('../src/modules/fits/fit.model');
const Inventory = require('../src/modules/inventory/inventory.model');
const DeviceToken = require('../src/modules/notifications/deviceToken.model');
const Order = require('../src/modules/orders/order.model');
const Product = require('../src/modules/products/product.model');
const ProductColour = require('../src/modules/productColours/productColour.model');
const SizeSet = require('../src/modules/sizeSets/sizeSet.model');
const SubCategory = require('../src/modules/subcategories/subCategory.model');
const User = require('../src/modules/users/user.model');
const ProductVariant = require('../src/modules/variants/productVariant.model');
const { generateAccessToken } = require('../src/utils/jwt');

const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

test('Admin permanent deletes are dependency-safe and preserve soft status actions', { timeout: 120000, skip: !URI && 'HARD_DELETE_TEST_MONGODB_URI replica-set URI is required' }, async () => {
  let server;
  const objects = new Set();
  let failDelete = false;
  storage.setObjectStorageAdapter({
    async uploadObject({ key }) { objects.add(key); return { key }; },
    async deleteObject({ key }) { if (failDelete) throw new Error('mock delete failed'); objects.delete(key); },
    async getObjectUrl({ key }) { return `https://example.test/${key}`; },
  });
  try {
    await mongoose.connect(URI); await mongoose.connection.dropDatabase();
    const password = 'Hard-Delete-Test-1!';
    const [admin, nonAdmin] = await User.create([
      { name: 'Delete Admin', email: 'delete.admin@example.test', phone: '9000000101', password, role: 'admin', status: 'active' },
      { name: 'Delete Wholesaler', email: 'delete.wholesaler@example.test', phone: '9000000102', password, role: 'wholesaler', status: 'active' },
    ]);
    const category = await Category.create({ name: 'Delete Category', sizeFamily: 'ALPHA' });
    const subCategory = await SubCategory.create({ category: category._id, name: 'Delete Sub' });
    const [fit, fabric, colour, sizeSet] = await Promise.all([
      Fit.create({ name: 'Delete Fit' }), Fabric.create({ name: 'Delete Fabric' }), Colour.create({ name: 'Delete Black' }),
      SizeSet.create({ label: 'S-M', sizes: ['S', 'M'], pieceCount: 2 }),
    ]);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const request = async (path, token, method = 'DELETE', body) => {
      const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, body: await response.json() };
    };
    const adminToken = generateAccessToken(admin); const nonAdminToken = generateAccessToken(nonAdmin);
    const makeProduct = async (name) => {
      const product = await Product.create({ catalogVersion: 2, name, category: category._id, subCategory: subCategory._id, fitId: fit._id, fabricId: fabric._id, mrpPerPieceMinor: 10000 });
      const key = `product-colours/${new mongoose.Types.ObjectId()}/${crypto.randomUUID()}.webp`;
      const productColour = await ProductColour.create({ product: product._id, colour: colour._id, productCode: `${name}_DELETE_BLACK`, images: [{ objectKey: key.replace(/product-colours\/[a-f\d]{24}/, `product-colours/${product._id}`), originalFilename: 'delete.webp', contentType: 'image/webp', size: 10, sortIndex: 0 }] });
      const actualKey = productColour.images[0].objectKey; objects.add(actualKey);
      const variant = await ProductVariant.create({ catalogVersion: 2, product: product._id, productColour: productColour._id, sizeSetRef: sizeSet._id, sku: `${productColour.productCode}_S-M` });
      return { product, productColour, variant, objectKey: actualKey };
    };

    const safe = await makeProduct('SAFEDELETE');
    assert.equal((await request(`/products/${safe.product._id}/permanent`, nonAdminToken)).status, 403);
    const safeDelete = await request(`/products/${safe.product._id}/permanent`, adminToken);
    assert.equal(safeDelete.status, 200, JSON.stringify(safeDelete.body));
    assert.equal(await Product.exists({ _id: safe.product._id }), null);
    assert.equal(await ProductColour.exists({ _id: safe.productColour._id }), null);
    assert.equal(await ProductVariant.exists({ _id: safe.variant._id }), null);
    assert.equal(objects.has(safe.objectKey), false);

    const cleanupFailure = await makeProduct('CLEANUPFAIL');
    failDelete = true;
    assert.equal((await request(`/products/${cleanupFailure.product._id}/permanent`, adminToken)).status, 502);
    failDelete = false;
    assert.equal(await Product.exists({ _id: cleanupFailure.product._id }), null);
    assert.equal(objects.has(cleanupFailure.objectKey), true);

    const stocked = await makeProduct('STOCKED');
    await Inventory.create({ variant: stocked.variant._id, sku: stocked.variant.sku, shelves: [{ shelf: 'A1', quantity: 1 }] });
    const stockedDelete = await request(`/products/${stocked.product._id}/permanent`, adminToken);
    assert.equal(stockedDelete.status, 409);
    assert.match(stockedDelete.body.message, /inventory stock is available/i);
    assert.ok(await Product.exists({ _id: stocked.product._id }));
    assert.equal((await request(`/products/${stocked.product._id}`, adminToken)).status, 200);
    assert.equal((await request(`/products/${stocked.product._id}`, adminToken, 'PATCH', { status: 'active' })).status, 200);
    const ordered = await makeProduct('ORDERED');
    await Order.collection.insertOne({ orderNumber: 'DELETE-ORDER-1', items: [{ productId: ordered.product._id, productColourId: ordered.productColour._id, skuId: ordered.variant._id }] });
    assert.equal((await request(`/products/${ordered.product._id}/permanent`, adminToken)).status, 409);
    assert.ok(await Order.exists({ 'items.productId': ordered.product._id }));

    const disposableWholesaler = await User.create({ name: 'Disposable Wholesale', email: 'disposable.wholesale@example.test', phone: '9000000103', password, role: 'wholesaler' });
    await Address.create({ user: disposableWholesaler._id, name: 'Test', phone: '9000000103', addressLine1: 'Line', city: 'City', state: 'State', postalCode: '12345', isDefault: true });
    await DeviceToken.create({ user: disposableWholesaler._id, token: `token-${crypto.randomBytes(24).toString('hex')}`, platform: 'android' });
    assert.equal((await request(`/wholesalers/${disposableWholesaler._id}/permanent`, adminToken)).status, 200);
    assert.equal(await User.exists({ _id: disposableWholesaler._id }), null);
    assert.equal(await Address.exists({ user: disposableWholesaler._id }), null);
    assert.equal(await DeviceToken.exists({ user: disposableWholesaler._id }), null);

    const parent = await User.create({ name: 'Parent Wholesale', email: 'parent.wholesale@example.test', phone: '9000000104', password, role: 'wholesaler', status: 'active' });
    const retailer = await User.create({ name: 'Owned Retailer', email: 'owned.retailer@example.test', phone: '9000000105', password, role: 'retailer', parentWholesaler: parent._id, status: 'active' });
    const parentToken = generateAccessToken(parent);
    assert.equal((await request(`/retailers/${retailer._id}/status`, parentToken, 'PATCH', { status: 'inactive' })).status, 200);
    assert.equal((await request(`/retailers/${retailer._id}/status`, parentToken, 'PATCH', { status: 'active' })).status, 200);
    assert.equal((await request(`/wholesalers/${parent._id}/permanent`, adminToken)).status, 409);
    assert.ok(await User.exists({ _id: retailer._id }));
    assert.equal((await request(`/retailers/${retailer._id}/permanent`, nonAdminToken)).status, 403);
    assert.equal((await request(`/retailers/${retailer._id}/permanent`, adminToken)).status, 200);

    await Order.collection.insertOne({ orderNumber: 'DELETE-ORDER-3', wholesaler: parent._id });
    assert.equal((await request(`/wholesalers/${parent._id}/permanent`, adminToken)).status, 409);
    assert.ok(await Order.exists({ wholesaler: parent._id }));

    const historyRetailer = await User.create({ name: 'History Retailer', email: 'history.retailer@example.test', phone: '9000000106', password, role: 'retailer', parentWholesaler: parent._id, status: 'active' });
    await Order.collection.insertOne({ orderNumber: 'DELETE-ORDER-2', retailer: historyRetailer._id });
    assert.equal((await request(`/retailers/${historyRetailer._id}/permanent`, adminToken)).status, 409);
    assert.ok(await Order.exists({ retailer: historyRetailer._id }));

    assert.equal((await request(`/wholesalers/${nonAdmin._id}/status`, adminToken, 'PATCH', { status: 'inactive' })).status, 200);
    assert.equal((await request(`/wholesalers/${nonAdmin._id}/status`, adminToken, 'PATCH', { status: 'active' })).status, 200);
  } finally {
    storage.resetObjectStorageAdapter();
    if (server) await close(server);
    await mongoose.disconnect();
  }
});
