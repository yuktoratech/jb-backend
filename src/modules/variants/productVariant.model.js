const mongoose = require('mongoose');

const {
  normalizeSku,
  normalizeSkuPart,
} = require('../../utils/sku');

const VARIANT_STATUSES = ['active', 'inactive'];

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

const ProductVariant = mongoose.model(
  'ProductVariant',
  productVariantSchema,
);

module.exports = ProductVariant;
