const mongoose = require('mongoose');
const { normalizeSku } = require('../../utils/sku');

const legacyOverridesSchema = new mongoose.Schema(
  {
    fit: { type: String, trim: true },
    patternWash: { type: String, trim: true },
    fabric: { type: String, trim: true },
    sleeves: { type: String, trim: true },
    waist: { type: String, trim: true },
  },
  { _id: false },
);

const productVariantSchema = new mongoose.Schema(
  {
    catalogVersion: { type: Number, enum: [2] },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      immutable: true,
      index: true,
    },
    productColour: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProductColour',
      required() { return this.catalogVersion === 2; },
      immutable: true,
      index: true,
    },
    sizeSetRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SizeSet',
      required() { return this.catalogVersion === 2; },
      immutable: true,
      index: true,
    },
    sku: {
      type: String,
      required: true,
      immutable: true,
      set: normalizeSku,
      maxlength: 255,
      match: /^[A-Z0-9]+(?:[A-Z0-9_-]*[A-Z0-9])?$/,
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
      required: true,
      index: true,
    },

    // Legacy fields remain available until migration validation is complete.
    color: { type: String, trim: true },
    sizeSet: { type: String, trim: true },
    sourceProductCode: { type: String, trim: true },
    attributeOverrides: { type: legacyOverridesSchema, default: undefined },
  },
  { timestamps: true, optimisticConcurrency: true },
);

productVariantSchema.index({ sku: 1 }, { unique: true, name: 'unique_variant_sku' });
productVariantSchema.index(
  { productColour: 1, sizeSetRef: 1 },
  {
    unique: true,
    name: 'unique_sku_per_product_colour_size_set',
    partialFilterExpression: {
      productColour: { $type: 'objectId' },
      sizeSetRef: { $type: 'objectId' },
    },
  },
);
productVariantSchema.index(
  { product: 1, status: 1, createdAt: -1 },
  { name: 'skus_by_product_status_and_date' },
);

module.exports = mongoose.model('ProductVariant', productVariantSchema);
