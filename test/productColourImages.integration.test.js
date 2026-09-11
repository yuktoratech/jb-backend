const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const mongoose = require('mongoose');
const sharp = require('sharp');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.JWT_EXPIRES_IN = '1h';
process.env.PRODUCT_IMAGE_MAX_BYTES = String(20 * 1024 * 1024);
const URI = process.env.PRODUCT_IMAGE_TEST_MONGODB_URI;

const storage = require('../src/storage/objectStorage.service');
const app = require('../src/app');
const Category = require('../src/modules/categories/category.model');
const Colour = require('../src/modules/colours/colour.model');
const Fabric = require('../src/modules/fabrics/fabric.model');
const Fit = require('../src/modules/fits/fit.model');
const Product = require('../src/modules/products/product.model');
const ProductColour = require('../src/modules/productColours/productColour.model');
const productColourService = require('../src/modules/productColours/productColour.service');
const SubCategory = require('../src/modules/subcategories/subCategory.model');
const User = require('../src/modules/users/user.model');
const { generateAccessToken } = require('../src/utils/jwt');

const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

test('ProductColour image objects use provider-neutral storage safely', { timeout: 120000, skip: !URI && 'PRODUCT_IMAGE_TEST_MONGODB_URI is required' }, async (t) => {
  let server;
  const PNG = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#223344' } }).png().toBuffer();
  const JPEG = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#445566' } }).jpeg().toBuffer();
  const WEBP = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#667788' } }).webp().toBuffer();
  const objects = new Map();
  let failUpload = false;
  let uploadsBeforeFailure = null;
  const deletedKeys = [];
  storage.setObjectStorageAdapter({
    async uploadObject({ key, body, contentType }) {
      if (failUpload || uploadsBeforeFailure === 0) throw new Error('mock upload failed');
      if (uploadsBeforeFailure !== null) uploadsBeforeFailure -= 1;
      objects.set(key, { body: Buffer.from(body), contentType });
      return { key };
    },
    async deleteObject({ key }) { deletedKeys.push(key); objects.delete(key); },
    async getObjectUrl({ key }) { return `https://catalog.example.test/${key}`; },
  });
  try {
    await mongoose.connect(URI); await mongoose.connection.dropDatabase();
    const password = 'Image-Test-1!';
    const [admin, wholesaler] = await User.create([
      { name: 'Image Admin', email: 'image-admin@example.test', phone: '9000000001', password, role: 'admin', status: 'active' },
      { name: 'Image Wholesale', email: 'image-wholesale@example.test', phone: '9876543210', password, role: 'wholesaler', status: 'active' },
    ]);
    const category = await Category.create({ name: 'Image Category' });
    const sub = await SubCategory.create({ category: category._id, name: 'Image Sub' });
    const [fit, fabric, black, blue] = await Promise.all([
      Fit.create({ name: 'Image Fit' }), Fabric.create({ name: 'Image Fabric' }),
      Colour.create({ name: 'Image Black' }), Colour.create({ name: 'Image Blue' }),
    ]);
    const product = await Product.create({ catalogVersion: 2, name: 'IMAGE', category: category._id, subCategory: sub._id, fitId: fit._id, fabricId: fabric._id, mrpPerPieceMinor: 10000 });
    const [colourA, colourB] = await ProductColour.create([
      { product: product._id, colour: black._id, productCode: 'image_black' },
      { product: product._id, colour: blue._id, productCode: 'image_blue' },
    ]);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const tokens = { admin: generateAccessToken(admin), wholesaler: generateAccessToken(wholesaler) };
    const jsonRequest = async (path, { method = 'GET', token, body } = {}) => {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const upload = async (colourId, token, buffer = PNG, type = 'image/png', filename = '../unsafe name.png', altText = 'Front view') => {
      const form = new FormData();
      form.append('image', new Blob([buffer], { type }), filename); form.append('altText', altText);
      const response = await fetch(`${base}/product-colours/${colourId}/images`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
      return { status: response.status, body: await response.json() };
    };
    const uploadMany = async (colourId, token, files) => {
      const form = new FormData();
      files.forEach(({ buffer, type, filename }) => form.append('images', new Blob([buffer], { type }), filename));
      const response = await fetch(`${base}/product-colours/${colourId}/images`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
      return { status: response.status, body: await response.json() };
    };

    await t.test('Admin upload stores safe metadata and non-Admin is rejected', async () => {
      assert.equal((await upload(colourA._id, tokens.wholesaler)).status, 403);
      const result = await upload(colourA._id, tokens.admin);
      assert.equal(result.status, 201, JSON.stringify(result.body));
      const image = result.body.data.images[0];
      assert.match(image.objectKey, new RegExp(`^product-colours/${colourA._id}/[a-f0-9-]+\\.webp$`));
      assert.equal(image.objectKey.includes('unsafe'), false); assert.equal(image.originalFilename, 'unsafe name.png');
      assert.equal(image.contentType, 'image/webp'); assert.equal(image.size, objects.get(image.objectKey).body.length); assert.equal(image.sortIndex, 0); assert.equal(image.altText, 'Front view');
      const metadata = await sharp(objects.get(image.objectKey).body).metadata();
      assert.equal(metadata.format, 'webp'); assert.equal(metadata.width, 800); assert.equal(metadata.height, 600);
      assert.equal(image.url, `https://catalog.example.test/${image.objectKey}`); assert.ok(objects.has(image.objectKey));
      const stored = await ProductColour.findById(colourA._id).lean();
      assert.equal(stored.images[0].objectKey, image.objectKey); assert.equal(Object.hasOwn(stored.images[0], 'url'), false);
    });

    await t.test('invalid content and oversized uploads never reach storage', async () => {
      const before = objects.size;
      assert.equal((await upload(colourA._id, tokens.admin, Buffer.from('not png'), 'image/png')).status, 400);
      assert.equal((await upload(colourA._id, tokens.admin, PNG, 'text/plain')).status, 400);
      assert.equal((await upload(colourA._id, tokens.admin, Buffer.alloc(20 * 1024 * 1024 + 1), 'image/png')).status, 413);
      assert.equal(objects.size, before);
    });

    await t.test('storage upload failure creates no metadata', async () => {
      const before = (await ProductColour.findById(colourA._id)).images.length;
      failUpload = true; const result = await upload(colourA._id, tokens.admin); failUpload = false;
      assert.equal(result.status, 502); assert.equal((await ProductColour.findById(colourA._id)).images.length, before);
    });

    await t.test('failed multi-image upload cleans earlier objects and creates no metadata', async () => {
      const beforeImages = (await ProductColour.findById(colourB._id)).images.length;
      const beforeKeys = new Set(objects.keys());
      uploadsBeforeFailure = 1;
      const result = await uploadMany(colourB._id, tokens.admin, [
        { buffer: PNG, type: 'image/png', filename: 'batch-one.png' },
        { buffer: JPEG, type: 'image/jpeg', filename: 'batch-two.jpg' },
      ]);
      uploadsBeforeFailure = null;
      assert.equal(result.status, 502);
      assert.equal((await ProductColour.findById(colourB._id)).images.length, beforeImages);
      assert.deepEqual(new Set(objects.keys()), beforeKeys);
    });

    await t.test('MongoDB failure after upload deletes the uploaded object', async () => {
      const beforeKeys = new Set(objects.keys());
      const beforeDeletes = deletedKeys.length;
      await assert.rejects(productColourService.uploadImage(colourA._id, { buffer: JPEG, size: JPEG.length, originalname: 'failure.jpg' }, { contentType: 'image/jpeg', extension: 'jpg' }, {}, {
        afterObjectUpload: () => { throw new Error('injected DB failure'); },
      }), /Unable to save image metadata/);
      const newKeys = deletedKeys.slice(beforeDeletes);
      assert.equal(newKeys.length, 1); assert.equal(objects.has(newKeys[0]), false); assert.deepEqual(new Set(objects.keys()), beforeKeys);
    });

    await t.test('batch upload accepts JPEG, PNG, and WebP, preserves order, and resizes without upscaling', async () => {
      const before = (await ProductColour.findById(colourB._id)).images.length;
      const result = await uploadMany(colourB._id, tokens.admin, [
        { buffer: JPEG, type: 'image/jpeg', filename: 'one.jpg' },
        { buffer: PNG, type: 'image/png', filename: 'two.png' },
        { buffer: WEBP, type: 'image/webp', filename: 'three.webp' },
      ]);
      assert.equal(result.status, 201, JSON.stringify(result.body));
      const added = result.body.data.images.slice(before);
      assert.deepEqual(added.map(({ originalFilename }) => originalFilename), ['one.jpg', 'two.png', 'three.webp']);
      assert.ok(added.every(({ contentType, objectKey }) => contentType === 'image/webp' && objectKey.endsWith('.webp')));
      const dimensions = await Promise.all(added.map(({ objectKey }) => sharp(objects.get(objectKey).body).metadata()));
      assert.deepEqual(dimensions.map(({ width, height }) => [width, height]), [[1200, 800], [800, 600], [1600, 1200]]);
    });

    await t.test('reorder requires all image IDs once and catalog response follows order', async () => {
      const second = await upload(colourA._id, tokens.admin, JPEG, 'image/jpeg', 'second.jpg', 'Back view');
      const images = second.body.data.images; const reversed = images.map(({ _id }) => _id).reverse();
      const reordered = await jsonRequest(`/product-colours/${colourA._id}/images/reorder`, { method: 'PATCH', token: tokens.admin, body: { imageIds: reversed } });
      assert.equal(reordered.status, 200); assert.deepEqual(reordered.body.data.images.map(({ _id }) => _id), reversed);
      const invalid = await jsonRequest(`/product-colours/${colourA._id}/images/reorder`, { method: 'PATCH', token: tokens.admin, body: { imageIds: [reversed[0], reversed[0]] } });
      assert.equal(invalid.status, 400);
      const catalog = await jsonRequest(`/products/${product._id}`, { token: tokens.wholesaler });
      assert.equal(catalog.status, 200); const presented = catalog.body.data.productColours.find(({ _id }) => _id === colourA._id.toString());
      assert.deepEqual(presented.images.map(({ _id }) => _id), reversed); assert.ok(presented.images.every(({ url }) => url.startsWith('https://catalog.example.test/')));
    });

    await t.test('cross-colour delete fails and owned delete removes metadata and object', async () => {
      const before = (await ProductColour.findById(colourB._id)).images.length;
      const bUpload = await upload(colourB._id, tokens.admin);
      const bImage = bUpload.body.data.images.at(-1);
      assert.equal((await jsonRequest(`/product-colours/${colourA._id}/images/${bImage._id}`, { method: 'DELETE', token: tokens.admin })).status, 404);
      assert.ok(objects.has(bImage.objectKey));
      const removed = await jsonRequest(`/product-colours/${colourB._id}/images/${bImage._id}`, { method: 'DELETE', token: tokens.admin });
      assert.equal(removed.status, 200); assert.equal(removed.body.data.images.length, before); assert.equal(objects.has(bImage.objectKey), false);
      assert.equal((await ProductColour.findById(colourB._id)).images.length, before);
    });
  } finally {
    storage.resetObjectStorageAdapter();
    if (server) await close(server);
    await mongoose.disconnect();
  }
});
