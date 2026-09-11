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

const HEADERS = ['Product Name', 'Product Code', 'SKU', 'Category', 'Product title', 'Colour', 'Size', 'MRP', 'Fit', 'Pattern/Wash', 'Fabric', 'Sleeves', 'Waist'];
const row = (overrides = {}) => {
  const values = { productName: 'CORE', category: 'Jeans', fit: 'Regular', fabric: 'Cotton', description: 'Core range', mrp: '1299.50', colour: 'BLACK', productCode: 'CORE_BLACK', sizeSet: '32-36', sku: 'CORE_BLACK_32-36', pattern: 'Ignored', sleeves: 'Ignored', waist: 'Ignored', ...overrides };
  return [values.productName, values.productCode, values.sku, values.category, values.description, values.colour, values.sizeSet, values.mrp, values.fit, values.pattern, values.fabric, values.sleeves, values.waist];
};
const workbook = (...rows) => xlsx([HEADERS, ...rows]);

test('finalized Product XLSX preview/apply is validated, persisted, and atomic', { timeout: 120000, skip: !URI && 'PRODUCT_IMPORT_TEST_MONGODB_URI replica-set URI is required' }, async (t) => {
  let server;
  try {
    await mongoose.connect(URI);
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    const transactionCapable = Boolean(hello.setName || hello.msg === 'isdbgrid');
    await mongoose.connection.dropDatabase();
    const admin = await User.create({ name: 'Import Admin', email: 'product-import@example.test', phone: '9000000001', password: 'Product-Import-1!', role: 'admin', status: 'active' });
    const otherAdmin = await User.create({ name: 'Other Admin', email: 'other-product-import@example.test', phone: '9000000002', password: 'Product-Import-2!', role: 'admin', status: 'active' });
    const category = await Category.create({ name: 'Jeans', sizeFamily: 'NUMERIC', status: 'active' });
    const otherCategory = await Category.create({ name: 'Shirts', sizeFamily: 'ALPHA', status: 'active' });
    await Promise.all([
      SubCategory.create({ category: category._id, name: 'Straight', status: 'active' }),
      SubCategory.create({ category: otherCategory._id, name: 'Formal', status: 'active' }),
      Colour.create({ name: 'Black', status: 'active' }),
      Colour.create({ name: 'Blue', status: 'active' }),
      Colour.create({ name: 'Dormant', status: 'inactive' }),
      Fit.create({ name: 'Regular', status: 'active' }),
      Fabric.create({ name: 'Cotton', status: 'active' }),
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
      assert.equal(normalized.expectedSku, 'CORE_BLACK_32-36');
      assert.equal(normalized.suppliedSku, 'CORE_BLACK_32-36');
      assert.ok(preview.body.data.warnings.some(({ code }) => code === 'IGNORED_LEGACY_COLUMN'));
      assert.equal(normalized.images, undefined);
      assert.equal(normalized.initialStock, undefined);
    });

    await t.test('headers, required data, masters, relationship, money, duplicates, and codes are rejected', async () => {
      const missingHeader = await upload([row()], HEADERS.filter((header) => header !== 'SKU'));
      assert.equal(missingHeader.body.data.status, 'INVALID');
      assert.ok(missingHeader.body.data.errors.some(({ code }) => code === 'MISSING_REQUIRED_FIELD'));
      const unknown = await upload([row({ category: 'Unknown' })]);
      assert.ok(unknown.body.data.errors.some(({ code }) => code === 'MASTER_NOT_FOUND'));
      const inactive = await upload([row({ colour: 'Dormant' })]);
      assert.ok(inactive.body.data.errors.some(({ code }) => code === 'MASTER_INACTIVE'));
      const ambiguousSubcategory = await SubCategory.create({ category: category._id, name: 'Other', status: 'active' });
      const mismatch = await upload([row()]);
      assert.ok(mismatch.body.data.errors.some(({ code }) => code === 'SUBCATEGORY_REQUIRED'));
      await ambiguousSubcategory.deleteOne();
      const badMoney = await upload([row({ mrp: '12.345' })]);
      assert.ok(badMoney.body.data.errors.some(({ code }) => code === 'INVALID_MRP'));
      const duplicate = await upload([row(), row()]);
      assert.ok(duplicate.body.data.errors.some(({ code }) => code === 'DUPLICATE_PRODUCT_COLOUR_SIZE_SET'));
      const badCode = await upload([row({ productCode: 'WRONG_CODE' })]);
      assert.ok(badCode.body.data.errors.some(({ code }) => code === 'PRODUCT_CODE_MISMATCH'));
    });

    await t.test('valid apply is atomic, idempotent, owner-bound, and creates no inventory/images', async () => {
      if (!transactionCapable) return t.skip('A transaction-capable MongoDB deployment is required');
      const preview = await upload([row(), row({ colour: 'BLUE', productCode: 'CORE_BLUE', sizeSet: '34-38', sku: 'CORE_BLUE_34-38' })]);
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
      assert.deepEqual((await ProductVariant.find({}).sort({ sku: 1 }).distinct('sku')), ['CORE_BLACK_32-36', 'CORE_BLUE_34-38']);
      const product = await Product.findOne({ catalogVersion: 2 }).lean();
      assert.equal(product.productName, undefined); assert.equal(product.title, undefined); assert.equal(product.patternWash, undefined);
      const repeated = await apply(preview.body.data.id);
      assert.equal(repeated.status, 409);
    });

    await t.test('catalog changes after preview make the batch stale and return 409', async () => {
      if (!transactionCapable) return t.skip('A transaction-capable MongoDB deployment is required');
      const preview = await upload([row({ productName: 'STALE', productCode: 'STALE_BLACK', sku: 'STALE_BLACK_32-36' })]);
      assert.equal(preview.body.data.status, 'VALID');
      await Fit.updateOne({ name: 'Regular' }, { $set: { status: 'inactive' } });
      const stale = await apply(preview.body.data.id);
      assert.equal(stale.status, 409);
      assert.equal((await ProductImportBatch.findById(preview.body.data.id).lean()).status, 'VALID');
      assert.equal(await Product.countDocuments({ name: 'STALE' }), 0);
      await Fit.updateOne({ name: 'Regular' }, { $set: { status: 'active' } });
    });

    await t.test('invalid/conflicting batches cannot apply and identical existing identities are reused', async () => {
      if (!transactionCapable) return t.skip('A transaction-capable MongoDB deployment is required');
      const invalid = await upload([row({ category: 'Missing' })]);
      assert.equal((await apply(invalid.body.data.id)).status, 409);
      const identical = await upload([row(), row({ colour: 'BLUE', productCode: 'CORE_BLUE', sizeSet: '34-38', sku: 'CORE_BLUE_34-38' })]);
      assert.equal(identical.body.data.status, 'VALID', JSON.stringify(identical.body.data.errors));
      const reused = await apply(identical.body.data.id);
      assert.equal(reused.body.data.existingProducts, 1);
      assert.equal(reused.body.data.existingVariants, 2);
      const priceUpdate = await upload([row({ mrp: '999.00' })]);
      assert.equal(priceUpdate.body.data.status, 'VALID');
      await apply(priceUpdate.body.data.id);
      assert.equal((await Product.findOne({ name: 'CORE' }).lean()).mrpPerPieceMinor, 99900);
    });

    await t.test('shared Product conflicts identify the exact field on every affected row', async () => {
      const conflict = await upload([
        row({ productName: 'PRICED', productCode: 'PRICED_BLACK', sku: 'PRICED_BLACK_32-36', mrp: '1000.00' }),
        row({ productName: 'PRICED', colour: 'BLUE', productCode: 'PRICED_BLUE', sku: 'PRICED_BLUE_34-38', sizeSet: '34-38', mrp: '1200.00' }),
      ]);
      assert.equal(conflict.body.data.status, 'INVALID');
      const priceErrors = conflict.body.data.errors.filter(({ code }) => code === 'PRODUCT_METADATA_CONFLICT');
      assert.deepEqual(priceErrors.map(({ rowNumber }) => rowNumber), [2, 3]);
      assert.ok(priceErrors.every(({ field }) => field === 'mrpPerPiece'));
      assert.match(priceErrors[0].message, /₹1000\.00/);
      assert.match(priceErrors[1].message, /₹1200\.00/);
    });

    await t.test('an injected failure rolls back all catalog and batch writes', async () => {
      if (!transactionCapable) return t.skip('A transaction-capable MongoDB deployment is required');
      const buffer = workbook(row({ productName: 'ROLLBACK', productCode: 'ROLLBACK_BLACK', sku: 'ROLLBACK_BLACK_32-36' }));
      const preview = await productImportService.previewImport(buffer, { uploadedBy: admin._id, originalFilename: 'rollback.xlsx' });
      await assert.rejects(productImportService.applyImport(preview.id, { performedBy: admin._id, afterCatalogWrites: () => { throw new Error('injected apply failure'); } }), /injected apply failure/);
      assert.equal(await Product.countDocuments({ name: 'ROLLBACK' }), 0);
      assert.equal((await ProductImportBatch.findById(preview.id).lean()).status, 'VALID');
    });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (mongoose.connection.readyState) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
  }
});
