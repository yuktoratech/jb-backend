const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseWorkbook } = require('../src/modules/productImports/productImport.parser');
const xlsx = require('./xlsxTestHelper');

const headers = ['Product Name', 'Category', 'Sub-category', 'Fit', 'Fabric', 'Description', 'MRP Per Piece', 'Colour', 'Product Code', 'Size Set', 'Status', 'SKU', 'Pattern/Wash', 'Sleeves', 'Waist', 'Images', 'Initial Stock', 'Shelf'];

test('finalized Product parser normalizes approved fields and only warns for legacy columns', async () => {
  const parsed = await parseWorkbook(xlsx([headers, ['Core Denim', 'Jeans', 'Straight', 'Regular', 'Cotton', 'Core range', '1299.50', 'Black', ' CORE Black ', '32 - 36', '', 'LEGACY-SKU', 'Wash', 'Sleeve', 'Waist', 'image-url', 10, 'A1']]));
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.rows[0].mrpPerPieceMinor, 129950);
  assert.equal(parsed.rows[0].productCode, 'core_black');
  assert.equal(parsed.rows[0].status, 'active');
  assert.equal(parsed.rows[0].legacySku, 'LEGACY-SKU');
  assert.equal(parsed.rows[0].images, undefined);
  assert.ok(parsed.warnings.every(({ code }) => code === 'IGNORED_LEGACY_COLUMN'));
});

test('finalized Product parser accepts safe legacy aliases but requires Sub-category data', async () => {
  const legacyHeaders = ['Product Name', 'Product Code', 'SKU', 'Category', 'Product title', 'Colour', 'Size', 'MRP', 'Fit', 'Fabric'];
  const parsed = await parseWorkbook(xlsx([legacyHeaders, ['Core Denim', 'Core Black', 'IGNORED', 'Jeans', 'Legacy description', 'Black', '32 - 36', 1299, 'Regular', 'Cotton']]));
  assert.equal(parsed.rows[0].description, 'Legacy description');
  assert.equal(parsed.rows[0].sizeSetLabel, '32 - 36');
  assert.equal(parsed.rows[0].mrpPerPieceMinor, 129900);
  assert.ok(parsed.errors.some(({ code }) => code === 'SUBCATEGORY_REQUIRED'));
});

test('finalized Product parser rejects unsafe money precision', async () => {
  const parsed = await parseWorkbook(xlsx([headers.slice(0, 11), ['Core Denim', 'Jeans', 'Straight', 'Regular', 'Cotton', '', '12.345', 'Black', 'Core Black', '32 - 36', 'active']]));
  assert.ok(parsed.errors.some(({ code }) => code === 'INVALID_MRP'));
});
