const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.JWT_EXPIRES_IN = '1h';

const URI = process.env.FINALIZED_CATALOG_TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/jb_b2b_finalized_catalog_test';
if (!/^jb_b2b_finalized_catalog_test(?:_|$)/.test(new URL(URI).pathname.slice(1))) throw new Error('FINALIZED_CATALOG_TEST_MONGODB_URI must target a safe test database');

const app = require('../src/app');
const Inventory = require('../src/modules/inventory/inventory.model');
const Product = require('../src/modules/products/product.model');
const ProductColour = require('../src/modules/productColours/productColour.model');
const ProductVariant = require('../src/modules/variants/productVariant.model');
const User = require('../src/modules/users/user.model');

const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

test('finalized Product, ProductColour, and immutable SKU catalog is enforced', { timeout: 60000 }, async () => {
  let server;
  try {
    await mongoose.connect(URI);
    await mongoose.connection.dropDatabase();
    const password = `Admin-${crypto.randomBytes(24).toString('base64url')}`;
    const admin = await User.create({ name: 'Catalog Admin', email: 'final.catalog@example.test', phone: '9000000001', password, role: 'admin', status: 'active' });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const request = async (path, { method = 'GET', token, body } = {}) => {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const login = await request('/auth/login', { method: 'POST', body: { email: admin.email, password } });
    const token = login.body.data.accessToken;
    const create = async (path, body) => {
      const result = await request(path, { method: 'POST', token, body });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      return result.body.data;
    };
    const category = await create('/categories', { name: 'Denim' });
    const subCategory = await create('/subcategories', { categoryId: category._id, name: 'Ankle Fit' });
    const colourWhite = await create('/colours', { name: 'White' });
    const colourBlack = await create('/colours', { name: 'Black' });
    const colourBlue = await create('/colours', { name: 'Blue' });
    const fit = await create('/fits', { name: 'Slim' });
    const fabric = await create('/fabrics', { name: 'Cotton' });
    const numericSizes = await create('/size-sets', { label: '32 - 40', sizes: ['32', '34', '36', '38', '40'] });
    const alphaSizes = await create('/size-sets', { label: 'S - XXL', sizes: ['S', 'M', 'L', 'XL', 'XXL'] });

    const callerProvidedSkuCreation = await request('/products', {
      method: 'POST', token,
      body: {
        name: 'Classic Denim',
        description: 'Core wholesale denim.',
        categoryId: category._id,
        subCategoryId: subCategory._id,
        fitId: fit._id,
        fabricId: fabric._id,
        mrpPerPieceMinor: 125000,
        productColours: [
          { colourId: colourWhite._id, productCode: '  Denim   White  ', skus: [{ sizeSetId: numericSizes._id }] },
          { colourId: colourBlack._id, productCode: 'Snitch Black', skus: [{ sizeSetId: alphaSizes._id, sku: ' Custom SKU 01 ' }] },
        ],
      },
    });
    assert.equal(callerProvidedSkuCreation.status, 400);
    assert.equal(await Product.countDocuments(), 0);

    const productCreation = await request('/products', {
      method: 'POST', token,
      body: {
        name: 'Classic Denim',
        description: 'Core wholesale denim.',
        categoryId: category._id,
        subCategoryId: subCategory._id,
        fitId: fit._id,
        fabricId: fabric._id,
        mrpPerPieceMinor: 125000,
        productColours: [
          { colourId: colourWhite._id, productCode: '  Denim   White  ', skus: [{ sizeSetId: numericSizes._id }] },
          { colourId: colourBlack._id, productCode: 'Snitch Black', skus: [{ sizeSetId: alphaSizes._id }] },
        ],
      },
    });
    assert.equal(productCreation.status, 201, JSON.stringify(productCreation.body));
    const data = productCreation.body.data;
    assert.equal(data.product.name, 'Classic Denim');
    assert.equal(data.product.mrpPerPieceMinor, 125000);
    assert.equal(data.product.productName, undefined);
    assert.equal(data.product.title, undefined);
    assert.equal(data.productColours.length, 2);
    const white = data.productColours.find((entry) => entry.productCode === 'denim_white');
    const black = data.productColours.find((entry) => entry.productCode === 'snitch_black');
    assert.equal(white.skus[0].sku, 'denim_white_32-40');
    assert.equal(black.skus[0].sku, 'snitch_black_s-xxl');
    assert.equal(white.skus[0].sizeSetRef.pieceCount, 5);

    const inventories = await Inventory.find({ variant: { $in: [white.skus[0]._id, black.skus[0]._id] } }).lean();
    assert.equal(inventories.length, 2);
    assert.ok(inventories.every((entry) => entry.totalQuantity === 0));
    const finalizedInventoryResponse = await request(`/inventory/sku/${white.skus[0].sku}`, { token });
    assert.equal(finalizedInventoryResponse.status, 200);
    assert.equal(finalizedInventoryResponse.body.data.product.name, 'Classic Denim');
    assert.equal(finalizedInventoryResponse.body.data.productColour.productCode, 'denim_white');
    assert.equal(finalizedInventoryResponse.body.data.colour.name, 'White');
    assert.equal(finalizedInventoryResponse.body.data.sizeSet.label, '32 - 40');
    assert.equal(finalizedInventoryResponse.body.data.reservedQuantity, undefined);

    const duplicateCode = await request('/product-colours', { method: 'POST', token, body: { productId: data.product._id, colourId: colourBlue._id, productCode: 'denim white' } });
    assert.equal(duplicateCode.status, 409);

    const duplicateColour = await request('/product-colours', { method: 'POST', token, body: { productId: data.product._id, colourId: colourWhite._id, productCode: 'different code' } });
    assert.equal(duplicateColour.status, 409);

    const callerProvidedStandaloneSku = await request(`/products/${data.product._id}/variants`, { method: 'POST', token, body: { productColourId: black._id, sizeSetId: numericSizes._id, sku: 'caller_override' } });
    assert.equal(callerProvidedStandaloneSku.status, 400);

    const immutableSku = await request(`/variants/${white.skus[0]._id}`, { method: 'PATCH', token, body: { sku: 'renamed' } });
    assert.equal(immutableSku.status, 400);
    const skuDocument = await ProductVariant.findById(white.skus[0]._id);
    skuDocument.sku = 'renamed';
    await skuDocument.save();
    assert.equal((await ProductVariant.findById(skuDocument._id).lean()).sku, 'denim_white_32-40');

    const referencedSizeSetEdit = await request(`/size-sets/${numericSizes._id}`, { method: 'PATCH', token, body: { sizes: ['30', '32'] } });
    assert.equal(referencedSizeSetEdit.status, 409);
    const referencedSizeSetStatus = await request(`/size-sets/${numericSizes._id}`, { method: 'PATCH', token, body: { status: 'inactive' } });
    assert.equal(referencedSizeSetStatus.status, 200);
    const inactiveSizeAssignment = await request(`/products/${data.product._id}/variants`, { method: 'POST', token, body: { productColourId: black._id, sizeSetId: numericSizes._id } });
    assert.equal(inactiveSizeAssignment.status, 404);

    const moveUsedSubCategory = await request(`/subcategories/${subCategory._id}`, { method: 'PATCH', token, body: { categoryId: (await create('/categories', { name: 'Shirts' }))._id } });
    assert.equal(moveUsedSubCategory.status, 409);

    const productCountBefore = await Product.countDocuments();
    const collisionProduct = await request('/products', {
      method: 'POST', token,
      body: { name: 'Collision', categoryId: category._id, subCategoryId: subCategory._id, fitId: fit._id, fabricId: fabric._id, mrpPerPieceMinor: 10000, productColours: [{ colourId: colourWhite._id, productCode: 'snitch black', skus: [{ sizeSetId: alphaSizes._id }] }] },
    });
    assert.equal(collisionProduct.status, 409);
    assert.equal(await Product.countDocuments(), productCountBefore);
    assert.equal(await ProductColour.countDocuments({ productCode: 'snitch_black' }), 1);
  } finally {
    if (server) await close(server);
    if (mongoose.connection.readyState) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
  }
});
