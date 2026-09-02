const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.JWT_EXPIRES_IN = '1h';
const URI = process.env.ADDRESS_TEST_MONGODB_URI;

const app = require('../src/app');
const Address = require('../src/modules/addresses/address.model');
const Category = require('../src/modules/categories/category.model');
const Colour = require('../src/modules/colours/colour.model');
const Fabric = require('../src/modules/fabrics/fabric.model');
const Fit = require('../src/modules/fits/fit.model');
const Order = require('../src/modules/orders/order.model');
const Product = require('../src/modules/products/product.model');
const ProductColour = require('../src/modules/productColours/productColour.model');
const SizeSet = require('../src/modules/sizeSets/sizeSet.model');
const SubCategory = require('../src/modules/subcategories/subCategory.model');
const User = require('../src/modules/users/user.model');
const Variant = require('../src/modules/variants/productVariant.model');
const { generateAccessToken } = require('../src/utils/jwt');

const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
const address = (suffix) => ({ name: `Buyer ${suffix}`, phone: '9876543210', addressLine1: `${suffix} Textile Market`, addressLine2: '', city: 'Surat', state: 'Gujarat', postalCode: '395002' });

test('Saved Addresses are owner-scoped and Orders retain immutable snapshots', { timeout: 120000, skip: !URI && 'ADDRESS_TEST_MONGODB_URI replica-set URI is required' }, async (t) => {
  let server;
  try {
    await mongoose.connect(URI);
    assert.ok((await mongoose.connection.db.admin().command({ hello: 1 })).setName);
    await mongoose.connection.dropDatabase();
    const password = 'Address-Test-1!';
    const [admin, wholesaler, otherWholesaler] = await User.create([
      { name: 'Admin', email: 'address-admin@example.test', password, role: 'admin', status: 'active' },
      { name: 'Wholesaler', email: 'address-wholesaler@example.test', password, role: 'wholesaler', status: 'active', discountPercent: 10 },
      { name: 'Other Wholesaler', email: 'address-other@example.test', password, role: 'wholesaler', status: 'active', discountPercent: 5 },
    ]);
    const retailer = await User.create({ name: 'Retailer', email: 'address-retailer@example.test', password, role: 'retailer', status: 'active', parentWholesaler: wholesaler._id, discountPercent: 12 });
    const category = await Category.create({ name: 'Address Category', slug: 'address-category' });
    const sub = await SubCategory.create({ category: category._id, name: 'Address Sub', slug: 'address-sub' });
    const [fit, fabric, colour, set] = await Promise.all([
      Fit.create({ name: 'Address Fit', slug: 'address-fit' }), Fabric.create({ name: 'Address Fabric', slug: 'address-fabric' }),
      Colour.create({ name: 'Address Black', slug: 'address-black' }), SizeSet.create({ label: 'Address S-L', sizes: ['S', 'M', 'L'] }),
    ]);
    const product = await Product.create({ catalogVersion: 2, name: 'Address Product', category: category._id, subCategory: sub._id, fitId: fit._id, fabricId: fabric._id, mrpPerPieceMinor: 10000 });
    const pc = await ProductColour.create({ product: product._id, colour: colour._id, productCode: 'address_black' });
    const sku = await Variant.create({ catalogVersion: 2, product: product._id, productColour: pc._id, sizeSetRef: set._id, sku: 'address_black_addresss-l' });

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const tokens = Object.fromEntries(Object.entries({ admin, wholesaler, otherWholesaler, retailer }).map(([key, user]) => [key, generateAccessToken(user)]));
    const request = async (path, { method = 'GET', token, body } = {}) => {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const createAddress = (token, data) => request('/addresses', { method: 'POST', token, body: data });

    await t.test('Wholesaler supports multiple CRUD addresses and one safely switched default', async () => {
      const first = await createAddress(tokens.wholesaler, { ...address('One'), isDefault: true });
      const second = await createAddress(tokens.wholesaler, address('Two'));
      assert.equal(first.status, 201); assert.equal(second.status, 201);
      const switched = await request(`/addresses/${second.body.data._id}/default`, { method: 'POST', token: tokens.wholesaler });
      assert.equal(switched.status, 200); assert.equal(switched.body.data.isDefault, true);
      const listed = await request('/addresses', { token: tokens.wholesaler });
      assert.equal(listed.body.data.length, 2); assert.equal(listed.body.data.filter(({ isDefault }) => isDefault).length, 1);
      assert.equal(listed.body.data.find(({ _id }) => _id === first.body.data._id).isDefault, false);
      const competingDefaults = await Promise.all([
        request(`/addresses/${first.body.data._id}/default`, { method: 'POST', token: tokens.wholesaler }),
        request(`/addresses/${second.body.data._id}/default`, { method: 'POST', token: tokens.wholesaler }),
      ]);
      assert.ok(competingDefaults.every(({ status }) => status === 200 || status === 409));
      assert.equal(await Address.countDocuments({ user: wholesaler._id, isDefault: true }), 1);
      const updated = await request(`/addresses/${second.body.data._id}`, { method: 'PATCH', token: tokens.wholesaler, body: { city: 'Ahmedabad' } });
      assert.equal(updated.body.data.city, 'Ahmedabad');
      const removed = await request(`/addresses/${first.body.data._id}`, { method: 'DELETE', token: tokens.wholesaler });
      assert.equal(removed.status, 200); assert.equal((await request('/addresses', { token: tokens.wholesaler })).body.data.length, 1);
    });

    await t.test('Retailer owns CRUD data and users/admin cannot cross address boundaries', async () => {
      const created = await createAddress(tokens.retailer, { ...address('Retailer'), isDefault: true });
      assert.equal(created.status, 201);
      assert.equal((await request('/addresses', { token: tokens.retailer })).body.data.length, 1);
      assert.equal((await request(`/addresses/${created.body.data._id}`, { token: tokens.otherWholesaler })).status, 404);
      assert.equal((await request(`/addresses/${created.body.data._id}`, { method: 'PATCH', token: tokens.otherWholesaler, body: { city: 'Mumbai' } })).status, 404);
      assert.equal((await request(`/addresses/${created.body.data._id}`, { method: 'DELETE', token: tokens.otherWholesaler })).status, 404);
      assert.equal((await request('/addresses', { token: tokens.admin })).status, 403);
      const updated = await request(`/addresses/${created.body.data._id}`, { method: 'PATCH', token: tokens.retailer, body: { addressLine1: 'Updated Retailer Market' } });
      assert.equal(updated.status, 200);
      assert.equal((await request(`/addresses/${created.body.data._id}`, { method: 'DELETE', token: tokens.retailer })).status, 200);
    });

    await t.test('owned saved address creates snapshot unaffected by later edit and delete', async () => {
      const saved = await createAddress(tokens.wholesaler, address('Historical'));
      const orderResponse = await request('/orders', { method: 'POST', token: tokens.wholesaler, body: { items: [{ skuId: sku._id.toString(), setQuantity: 1 }], addressId: saved.body.data._id } });
      assert.equal(orderResponse.status, 201, JSON.stringify(orderResponse.body));
      const orderId = orderResponse.body.data._id;
      const snapshot = { ...orderResponse.body.data.deliveryAddress };
      await request(`/addresses/${saved.body.data._id}`, { method: 'PATCH', token: tokens.wholesaler, body: { city: 'Changed City' } });
      assert.deepEqual((await Order.findById(orderId).lean()).deliveryAddress, snapshot);
      await request(`/addresses/${saved.body.data._id}`, { method: 'DELETE', token: tokens.wholesaler });
      assert.deepEqual((await Order.findById(orderId).lean()).deliveryAddress, snapshot);
    });

    await t.test('another user address is rejected by Order ownership verification', async () => {
      const foreign = await createAddress(tokens.otherWholesaler, address('Foreign'));
      const response = await request('/orders', { method: 'POST', token: tokens.wholesaler, body: { items: [{ skuId: sku._id.toString(), setQuantity: 1 }], addressId: foreign.body.data._id } });
      assert.equal(response.status, 404); assert.equal(await Order.countDocuments({ placedBy: wholesaler._id }), 1);
    });

    await t.test('validated inline address creates an Order and can optionally be saved', async () => {
      const before = await Address.countDocuments({ user: retailer._id });
      const response = await request('/orders', { method: 'POST', token: tokens.retailer, body: { items: [{ skuId: sku._id.toString(), setQuantity: 2 }], deliveryAddress: address('Inline'), saveAddress: true } });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      assert.equal(response.body.data.deliveryAddress.city, 'Surat');
      assert.equal(await Address.countDocuments({ user: retailer._id }), before + 1);
      const invalid = await request('/orders', { method: 'POST', token: tokens.retailer, body: { items: [{ skuId: sku._id.toString(), setQuantity: 1 }], deliveryAddress: { ...address('Bad'), phone: 'x' } } });
      assert.equal(invalid.status, 400);
    });
  } finally {
    if (server) await close(server);
    await mongoose.disconnect();
  }
});
