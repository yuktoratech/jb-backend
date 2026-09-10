const assert = require('node:assert/strict');
const { test } = require('node:test');

const { canonicalizeSizeSet, inferSizeFamily } = require('../src/modules/sizeSets/sizeSetCanonical');
const {
  generateProductCodeBase,
  generateSku,
  normalizeProductName,
} = require('../src/utils/sku');

test('Product Name is a single uppercase token and never rewrites spaces', () => {
  assert.equal(normalizeProductName('shirt'), 'SHIRT');
  assert.equal(normalizeProductName('POLO_SHIRT'), 'POLO_SHIRT');
  assert.equal(normalizeProductName('T-SHIRT'), 'T-SHIRT');
  assert.throws(
    () => normalizeProductName('CLASSIC SHIRT'),
    /Product name cannot contain spaces\./,
  );
  assert.throws(
    () => normalizeProductName('SHIRT\tBLACK'),
    /Product name cannot contain spaces\./,
  );
});

test('Product Code and SKU generation use uppercase canonical identifiers', () => {
  assert.equal(generateProductCodeBase('shirt', 'black'), 'SHIRT_BLACK');
  assert.equal(generateSku('shirt_black', '32 - 40'), 'SHIRT_BLACK_32-40');
});

test('numeric Size ranges expand by two and alpha ranges follow approved order', () => {
  assert.equal(inferSizeFamily('30-38'), 'NUMERIC');
  assert.equal(inferSizeFamily('s-xl'), 'ALPHA');
  assert.deepEqual(canonicalizeSizeSet('32-40', 'NUMERIC'), {
    label: '32-40', sizes: ['32', '34', '36', '38', '40'], pieceCount: 5,
  });
  assert.deepEqual(canonicalizeSizeSet('S-2XL', 'ALPHA'), {
    label: 'S-2XL', sizes: ['S', 'M', 'L', 'XL', '2XL'], pieceCount: 5,
  });
  assert.throws(() => canonicalizeSizeSet('31-36', 'NUMERIC'), /not a valid numeric size range/);
  assert.throws(() => canonicalizeSizeSet('S,XL', 'ALPHA'), /supported order/);
});
