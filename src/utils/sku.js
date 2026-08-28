const SKU_PART_MAX_LENGTH = 100;
const SKU_MAX_LENGTH = 255;

const removeDiacritics = (value) =>
  value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

const assertString = (value, fieldName) => {
  if (typeof value !== 'string') {
    throw new TypeError(`${fieldName} must be a string`);
  }
};

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

  if (!normalized) {
    throw new TypeError(`${fieldName} must contain letters or numbers`);
  }

  if (normalized.length > SKU_PART_MAX_LENGTH) {
    throw new TypeError(
      `${fieldName} must not exceed ${SKU_PART_MAX_LENGTH} normalized characters`,
    );
  }

  return normalized;
};

const normalizeSku = (value) => {
  assertString(value, 'SKU');

  const normalized = removeDiacritics(value)
    .trim()
    .toUpperCase()
    .replace(/[\u2018\u2019']/g, '')
    .replace(/\s*_\s*/g, '_')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^A-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/-*_+-*/g, '_')
    .replace(/^[-_]+|[-_]+$/g, '');

  if (!normalized) {
    throw new TypeError('SKU must contain letters or numbers');
  }

  if (normalized.length > SKU_MAX_LENGTH) {
    throw new TypeError(
      `SKU must not exceed ${SKU_MAX_LENGTH} normalized characters`,
    );
  }

  return normalized;
};

const generateSku = (productName, color, sizeSet) =>
  normalizeSku(
    [
      normalizeSkuPart(productName, 'Product name'),
      normalizeSkuPart(color, 'Color'),
      normalizeSkuPart(sizeSet, 'Size set'),
    ].join('_'),
  );

module.exports = {
  generateSku,
  normalizeSku,
  normalizeSkuPart,
};
