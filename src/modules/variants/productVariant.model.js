const mongoose = require('mongoose');

const {
  normalizeSku,
  normalizeSkuPart,
} = require('../../utils/sku');

const VARIANT_STATUSES = ['active', 'inactive'];
const SOURCE_PRODUCT_CODE_PATTERN = /^[A-Z0-9]+(?:[-_][A-Z0-9]+)*$/;

const variantAttributeOverridesSchema = new mongoose.Schema(
  {
    fit: { type: String, trim: true, maxlength: 200 },
    patternWash: { type: String, trim: true, maxlength: 200 },
    fabric: { type: String, trim: true, maxlength: 200 },
    sleeves: { type: String, trim: true, maxlength: 200 },
    waist: { type: String, trim: true, maxlength: 100 },
  },
  { _id: false },
);

const productVariantSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      index: true,
    },
    color: {
      type: String,
      required: true,
      set: (value) => normalizeSkuPart(value, 'Color'),
    },
    sizeSet: {
      type: String,
      required: true,
      set: (value) => normalizeSkuPart(value, 'Size set'),
    },
    sku: {
      type: String,
      required: true,
      set: normalizeSku,
    },
    sourceProductCode: {
      type: String,
      set: normalizeSku,
      maxlength: [100, 'Source product code must not exceed 100 characters'],
      validate: {
        validator: (value) =>
          value === undefined || SOURCE_PRODUCT_CODE_PATTERN.test(value),
        message:
          'Source product code may contain only letters, numbers, hyphens, and underscores',
      },
    },
    attributeOverrides: {
      type: variantAttributeOverridesSchema,
      default: undefined,
    },
    status: {
      type: String,
      enum: VARIANT_STATUSES,
      default: 'active',
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
  },
);

productVariantSchema.index(
  { sku: 1 },
  { unique: true, name: 'unique_variant_sku' },
);

productVariantSchema.index(
  { product: 1, color: 1, sizeSet: 1 },
  {
    unique: true,
    name: 'unique_product_color_size_set',
  },
);

productVariantSchema.index(
  { product: 1, sourceProductCode: 1 },
  {
    name: 'variants_by_source_product_code',
    partialFilterExpression: { sourceProductCode: { $type: 'string' } },
  },
);

const ProductVariant = mongoose.model(
  'ProductVariant',
  productVariantSchema,
);

module.exports = ProductVariant;
