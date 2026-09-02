const PRODUCT_CODE_MAX_LENGTH = 100;
const SIZE_SET_TOKEN_MAX_LENGTH = 100;
const SKU_MAX_LENGTH = 255;

const removeDiacritics = (value) =>
  value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

const assertString = (value, fieldName) => {
  if (typeof value !== 'string') throw new TypeError(`${fieldName} must be a string`);
};

const normalizeProductCode = (value) => {
  assertString(value, 'Product code');
  const normalized = removeDiacritics(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/^_+|_+$/g, '');
  if (!normalized) throw new TypeError('Product code must contain letters or numbers');
  if (normalized.length > PRODUCT_CODE_MAX_LENGTH) {
    throw new TypeError(`Product code must not exceed ${PRODUCT_CODE_MAX_LENGTH} normalized characters`);
  }
  return normalized;
};

const normalizeSizeSetToken = (value) => {
  assertString(value, 'SizeSet label');
  const normalized = removeDiacritics(value)
    .trim()
    .toLowerCase()
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, '')
    .replace(/-+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '');
  if (!normalized) throw new TypeError('SizeSet label must contain letters or numbers');
  if (normalized.length > SIZE_SET_TOKEN_MAX_LENGTH) {
    throw new TypeError(`SizeSet token must not exceed ${SIZE_SET_TOKEN_MAX_LENGTH} normalized characters`);
  }
  return normalized;
};

const normalizeSku = (value) => {
  assertString(value, 'SKU');
  const normalized = removeDiacritics(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/-+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[-_]+|[-_]+$/g, '');
  if (!normalized) throw new TypeError('SKU must contain letters or numbers');
  if (normalized.length > SKU_MAX_LENGTH) {
    throw new TypeError(`SKU must not exceed ${SKU_MAX_LENGTH} normalized characters`);
  }
  return normalized;
};

const generateSku = (productCode, sizeSetLabel) =>
  normalizeSku(`${normalizeProductCode(productCode)}_${normalizeSizeSetToken(sizeSetLabel)}`);

// Legacy migration parsing only. New APIs use the purpose-specific helpers.
const normalizeSkuPart = (value, fieldName = 'SKU component') => {
  assertString(value, fieldName);
  const normalized = removeDiacritics(value)
    .trim()
    .toUpperCase()
    .replace(/[\u2018\u2019']/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/[^A-Z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!normalized) throw new TypeError(`${fieldName} must contain letters or numbers`);
  return normalized;
};

module.exports = {
  generateSku,
  normalizeProductCode,
  normalizeSizeSetToken,
  normalizeSku,
  normalizeSkuPart,
};
