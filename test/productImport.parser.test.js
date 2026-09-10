const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseWorkbook } = require('../src/modules/productImports/productImport.parser');
const xlsx = require('./xlsxTestHelper');

const headers = [
  'Product Name', 'Product Code', 'SKU', 'Category', 'Product title', 'Colour',
  'Size', 'MRP', 'Fit', 'Pattern/Wash', 'Fabric', 'Sleeves', 'Waist',
];

test('Product parser accepts the client workbook contract and normalizes identifiers', async () => {
  const parsed = await parseWorkbook(xlsx([headers, [
    'shirt', 'shirt_black', 'shirt_black_32-36', 'Jeans', 'Core range',
    'black', '32-36', '1299.50', 'Regular', 'Wash', 'Cotton', 'Sleeve', 'Waist',
  ]]));

  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rows[0].productName, 'SHIRT');
  assert.equal(parsed.rows[0].productCode, 'SHIRT_BLACK');
  assert.equal(parsed.rows[0].suppliedSku, 'SHIRT_BLACK_32-36');
  assert.equal(parsed.rows[0].colourName, 'BLACK');
  assert.equal(parsed.rows[0].description, 'Core range');
  assert.equal(parsed.rows[0].mrpPerPieceMinor, 129950);
  assert.deepEqual(parsed.warnings.map(({ code }) => code), [
    'IGNORED_LEGACY_COLUMN', 'IGNORED_LEGACY_COLUMN', 'IGNORED_LEGACY_COLUMN',
  ]);
});

test('Product parser rejects Product Names containing whitespace with the approved message', async () => {
  const parsed = await parseWorkbook(xlsx([headers, [
    'CLASSIC SHIRT', 'CLASSIC_SHIRT_BLACK', 'CLASSIC_SHIRT_BLACK_M-XL', 'Shirts',
    '', 'BLACK', 'M-XL', 1199, 'Regular', '', 'Cotton', '', '',
  ]]));

  const issue = parsed.errors.find(({ code }) => code === 'INVALID_PRODUCT_NAME');
  assert.equal(issue.message, 'Product name cannot contain spaces.');
});

test('Product parser requires supplied Product Code and SKU', async () => {
  const parsed = await parseWorkbook(xlsx([headers, [
    'SHIRT', '', '', 'Shirts', '', 'BLACK', 'M-XL', 1199, 'Regular', '', 'Cotton', '', '',
  ]]));
  assert.ok(parsed.errors.some(({ field }) => field === 'productCode'));
  assert.ok(parsed.errors.some(({ field }) => field === 'suppliedSku'));
});

test('Product parser rejects zero and unsafe money precision', async () => {
  const row = ['SHIRT', 'SHIRT_BLACK', 'SHIRT_BLACK_M-XL', 'Shirts', '', 'BLACK', 'M-XL'];
  const zero = await parseWorkbook(xlsx([headers, [...row, 0, 'Regular', '', 'Cotton', '', '']]));
  const precision = await parseWorkbook(xlsx([headers, [...row, '12.345', 'Regular', '', 'Cotton', '', '']]));
  assert.ok(zero.errors.some(({ code }) => code === 'INVALID_MRP'));
  assert.ok(precision.errors.some(({ code }) => code === 'INVALID_MRP'));
});
