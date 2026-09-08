const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.JWT_EXPIRES_IN = '1h';

const URI = process.env.PRODUCT_IMPORT_TEST_MONGODB_URI;
const app = require('../src/app');
const Category = require('../src/modules/categories/category.model');
const SubCategory = require('../src/modules/subcategories/subCategory.model');
const Colour = require('../src/modules/colours/colour.model');
const Fit = require('../src/modules/fits/fit.model');
const Fabric = require('../src/modules/fabrics/fabric.model');
const SizeSet = require('../src/modules/sizeSets/sizeSet.model');
const Product = require('../src/modules/products/product.model');
const ProductColour = require('../src/modules/productColours/productColour.model');
const ProductVariant = require('../src/modules/variants/productVariant.model');
const Inventory = require('../src/modules/inventory/inventory.model');
const ProductImportBatch = require('../src/modules/productImports/productImport.model');
const productImportService = require('../src/modules/productImports/productImport.service');
const User = require('../src/modules/users/user.model');
const { generateAccessToken } = require('../src/utils/jwt');
const xlsx = require('./xlsxTestHelper');

const HEADERS = ['Product Name', 'Category', 'Sub-category', 'Fit', 'Fabric', 'Description', 'MRP Per Piece', 'Colour', 'Product Code', 'Size Set', 'Status', 'SKU', 'Pattern/Wash', 'Sleeves', 'Waist', 'Images', 'Initial Stock', 'Shelf'];
const row = (overrides = {}) => {
  const values = { productName: 'Core Denim', category: 'Jeans', subCategory: 'Straight', fit: 'Regular', fabric: 'Cotton', description: 'Core range', mrp: '1299.50', colour: 'Black', productCode: 'CORE Black', sizeSet: '32 - 36', status: 'active', sku: 'WRONG_UPPERCASE_SKU', pattern: 'Ignored', sleeves: 'Ignored', waist: 'Ignored', images: 'https://invalid.test/image.jpg', stock: 50, shelf: 'A1', ...overrides };
  return [values.productName, values.category, values.subCategory, values.fit, values.fabric, values.description, values.mrp, values.colour, values.productCode, values.sizeSet, values.status, values.sku, values.pattern, values.sleeves, values.waist, values.images, values.stock, values.shelf];
};
const workbook = (...rows) => xlsx([HEADERS, ...rows]);

test('finalized Product XLSX preview/apply is validated, persisted, and atomic', { timeout: 120000, skip: !URI && 'PRODUCT_IMPORT_TEST_MONGODB_URI replica-set URI is required' }, async (t) => {
  let server;
  try {
    await mongoose.connect(URI);
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    const transactionCapable = Boolean(hello.setName || hello.msg === 'isdbgrid');
    await mongoose.connection.dropDatabase();
    const admin = await User.create({ name: 'Import Admin', email: 'product-import@example.test', password: 'Product-Import-1!', role: 'admin', status: 'active' });
    const otherAdmin = await User.create({ name: 'Other Admin', email: 'other-product-import@example.test', password: 'Product-Import-2!', role: 'admin', status: 'active' });
    const category = await Category.create({ name: 'Jeans', slug: 'jeans', status: 'active' });
    const otherCategory = await Category.create({ name: 'Shirts', slug: 'shirts', status: 'active' });
    await Promise.all([
      SubCategory.create({ category: category._id, name: 'Straight', slug: 'straight', status: 'active' }),
      SubCategory.create({ category: otherCategory._id, name: 'Formal', slug: 'formal', status: 'active' }),
      Colour.create({ name: 'Black', slug: 'black', status: 'active' }),
      Colour.create({ name: 'Blue', slug: 'blue', status: 'active' }),
      Colour.create({ name: 'Dormant', slug: 'dormant', status: 'inactive' }),
      Fit.create({ name: 'Regular', slug: 'regular', status: 'active' }),
      Fabric.create({ name: 'Cotton', slug: 'cotton', status: 'active' }),
      SizeSet.create({ label: '32 - 36', sizes: ['32', '34', '36'], status: 'active' }),
      SizeSet.create({ label: 'S - XL', sizes: ['S', 'M', 'L', 'XL'], status: 'active' }),
    ]);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const token = generateAccessToken(admin);
    const upload = async (rows, headers = HEADERS) => {
      const form = new FormData();
      form.append('file', new Blob([xlsx([headers, ...rows])], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'products.xlsx');
      const response = await fetch(`${base}/product-imports/preview`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
      return { status: response.status, body: await response.json() };
    };
    const apply = async (batchId, actorToken = token) => {
      const response = await fetch(`${base}/product-imports/${batchId}/apply`, { method: 'POST', headers: { Authorization: `Bearer ${actorToken}` } });
      return { status: response.status, body: await response.json() };
    };

    await t.test('valid preview resolves masters, converts money, generates SKU, and ignores legacy fields', async () => {
      const preview = await upload([row()]);
      assert.equal(preview.status, 201, JSON.stringify(preview.body));
      assert.equal(preview.body.data.status, 'VALID');
      assert.equal(preview.body.data.validRows, 1);
      const normalized = preview.body.data.normalizedRows[0];
      assert.equal(normalized.mrpPerPieceMinor, 129950);
      assert.equal(normalized.expectedSku, 'core_black_32-36');
      assert.equal(normalized.legacySku, 'WRONG_UPPERCASE_SKU');
      assert.ok(preview.body.data.warnings.some(({ code }) => code === 'IGNORED_LEGACY_COLUMN'));
      assert.equal(normalized.images, undefined);
      assert.equal(normalized.initialStock, undefined);
    });

    await t.test('headers, required data, masters, relationship, money, duplicates, and codes are rejected', async () => {
      const missingHeader = await upload([row()], HEADERS.filter((header) => header !== 'Sub-category'));
      assert.equal(missingHeader.body.data.status, 'INVALID');
      assert.ok(missingHeader.body.data.errors.some(({ code }) => code === 'SUBCATEGORY_REQUIRED'));
      const unknown = await upload([row({ category: 'Unknown' })]);
      assert.ok(unknown.body.data.errors.some(({ code }) => code === 'MASTER_NOT_FOUND'));
      const inactive = await upload([row({ colour: 'Dormant' })]);
      assert.ok(inactive.body.data.errors.some(({ code }) => code === 'MASTER_INACTIVE'));
      const mismatch = await upload([row({ subCategory: 'Formal' })]);
      assert.ok(mismatch.body.data.errors.some(({ code }) => code === 'SUBCATEGORY_CATEGORY_MISMATCH'));
      const badMoney = await upload([row({ mrp: '12.345' })]);
      assert.ok(badMoney.body.data.errors.some(({ code }) => code === 'INVALID_MRP'));
      const duplicate = await upload([row(), row()]);
      assert.ok(duplicate.body.data.errors.some(({ code }) => code === 'DUPLICATE_ROW'));
      assert.ok(duplicate.body.data.errors.some(({ code }) => code === 'DUPLICATE_PRODUCT_COLOUR_SIZE_SET'));
      const codeConflict = await upload([row(), row({ colour: 'Blue', sizeSet: 'S - XL' })]);
      assert.ok(codeConflict.body.data.errors.some(({ code }) => code === 'PRODUCT_CODE_CONFLICT'));
    });

    await t.test('valid apply is atomic, idempotent, owner-bound, and creates no inventory/images', async () => {
      if (!transactionCapable) return t.skip('A transaction-capable MongoDB deployment is required');
      const preview = await upload([row(), row({ colour: 'Blue', productCode: 'Core Blue', sizeSet: 'S - XL', sku: 'ignored' })]);
      const wrongOwner = await apply(preview.body.data.id, generateAccessToken(otherAdmin));
      assert.equal(wrongOwner.status, 404);
      const result = await apply(preview.body.data.id);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.deepEqual(result.body.data.createdProducts, 1);
      assert.equal(await Product.countDocuments({ catalogVersion: 2 }), 1);
      assert.equal(await ProductColour.countDocuments(), 2);
      assert.equal(await ProductVariant.countDocuments(), 2);
      assert.equal(await Inventory.countDocuments(), 0);
      assert.ok((await ProductColour.find({}).lean()).every(({ images }) => images.length === 0));
      assert.deepEqual((await ProductVariant.find({}).sort({ sku: 1 }).distinct('sku')), ['core_black_32-36', 'core_blue_s-xl']);
      const product = await Product.findOne({ catalogVersion: 2 }).lean();
      assert.equal(product.productName, undefined); assert.equal(product.title, undefined); assert.equal(product.patternWash, undefined);
      const repeated = await apply(preview.body.data.id);
      assert.equal(repeated.status, 409);
    });

    await t.test('catalog changes after preview make the batch stale and return 409', async () => {
      if (!transactionCapable) return t.skip('A transaction-capable MongoDB deployment is required');
      const preview = await upload([row({ productName: 'Stale Product', productCode: 'Stale Black' })]);
      assert.equal(preview.body.data.status, 'VALID');
      await Fit.updateOne({ name: 'Regular' }, { $set: { status: 'inactive' } });
      const stale = await apply(preview.body.data.id);
      assert.equal(stale.status, 409);
      assert.equal((await ProductImportBatch.findById(preview.body.data.id).lean()).status, 'VALID');
      assert.equal(await Product.countDocuments({ name: 'Stale Product' }), 0);
      await Fit.updateOne({ name: 'Regular' }, { $set: { status: 'active' } });
    });

    await t.test('invalid/conflicting batches cannot apply and identical existing identities are reused', async () => {
      if (!transactionCapable) return t.skip('A transaction-capable MongoDB deployment is required');
      const invalid = await upload([row({ category: 'Missing' })]);
      assert.equal((await apply(invalid.body.data.id)).status, 409);
      const identical = await upload([row(), row({ colour: 'Blue', productCode: 'Core Blue', sizeSet: 'S - XL' })]);
      assert.equal(identical.body.data.status, 'VALID', JSON.stringify(identical.body.data.errors));
      const reused = await apply(identical.body.data.id);
      assert.equal(reused.body.data.existingProducts, 1);
      assert.equal(reused.body.data.existingVariants, 2);
      const conflict = await upload([row({ mrp: '999.00' })]);
      assert.ok(conflict.body.data.errors.some(({ code }) => code === 'EXISTING_CATALOG_CONFLICT'));
    });

    await t.test('an injected failure rolls back all catalog and batch writes', async () => {
      if (!transactionCapable) return t.skip('A transaction-capable MongoDB deployment is required');
      const buffer = workbook(row({ productName: 'Rollback Product', productCode: 'Rollback Black' }));
      const preview = await productImportService.previewImport(buffer, { uploadedBy: admin._id, originalFilename: 'rollback.xlsx' });
      await assert.rejects(productImportService.applyImport(preview.id, { performedBy: admin._id, afterCatalogWrites: () => { throw new Error('injected apply failure'); } }), /injected apply failure/);
      assert.equal(await Product.countDocuments({ name: 'Rollback Product' }), 0);
      assert.equal((await ProductImportBatch.findById(preview.id).lean()).status, 'VALID');
    });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (mongoose.connection.readyState) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
  }
});
