const mongoose = require('mongoose');
const { normalizeProductCode } = require('../../utils/sku');

const imageSchema = new mongoose.Schema({
  objectKey: { type: String, required: true, immutable: true, maxlength: 500, match: /^product-colours\/[a-f\d]{24}\/[a-f\d-]+\.(?:jpg|png|webp)$/ },
  originalFilename: { type: String, required: true, immutable: true, trim: true, maxlength: 255 },
  contentType: { type: String, required: true, immutable: true, enum: ['image/jpeg', 'image/png', 'image/webp'] },
  size: { type: Number, required: true, immutable: true, min: 1, validate: { validator: Number.isSafeInteger, message: 'Image size must be a positive whole number' } },
  sortIndex: { type: Number, required: true, min: 0, validate: { validator: Number.isSafeInteger, message: 'Image sort index must be a non-negative whole number' } },
  altText: { type: String, trim: true, default: '', maxlength: 300 },
  createdAt: { type: Date, required: true, default: Date.now, immutable: true },
}, { _id: true });

const productColourSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      immutable: true,
      index: true,
    },
    colour: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Colour',
      required: true,
      immutable: true,
      index: true,
    },
    productCode: {
      type: String,
      required: true,
      immutable: true,
      set: normalizeProductCode,
      maxlength: 100,
      match: /^[a-z0-9]+(?:_[a-z0-9]+)*$/,
    },
    images: {
      type: [imageSchema],
      default: [],
      validate: {
        validator: (images) => images.length <= 50 && new Set(images.map(({ objectKey }) => objectKey)).size === images.length && new Set(images.map(({ sortIndex }) => sortIndex)).size === images.length,
        message: 'ProductColour images must have unique keys and sort indexes and cannot exceed 50',
      },
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
      required: true,
      index: true,
    },
  },
  { timestamps: true, optimisticConcurrency: true },
);

productColourSchema.index(
  { productCode: 1 },
  { unique: true, name: 'unique_product_colour_code' },
);
productColourSchema.index(
  { product: 1, colour: 1 },
  { unique: true, name: 'unique_colour_per_product' },
);
productColourSchema.index(
  { product: 1, status: 1, createdAt: -1 },
  { name: 'product_colours_by_product_status_and_date' },
);

module.exports = mongoose.model('ProductColour', productColourSchema);
