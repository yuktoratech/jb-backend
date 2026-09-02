const mongoose = require('mongoose');

const isNonNegativeSafeInteger = (value) =>
  value === undefined || (Number.isSafeInteger(value) && value >= 0);

const productSchema = new mongoose.Schema(
  {
    catalogVersion: { type: Number, enum: [2] },
    name: {
      type: String,
      trim: true,
      maxlength: 150,
      required() { return this.catalogVersion === 2; },
    },
    description: { type: String, trim: true, maxlength: 5000 },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
      index: true,
    },
    subCategory: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SubCategory',
      required() { return this.catalogVersion === 2; },
      index: true,
    },
    fitId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Fit',
      required() { return this.catalogVersion === 2; },
      index: true,
    },
    fabricId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Fabric',
      required() { return this.catalogVersion === 2; },
      index: true,
    },
    mrpPerPieceMinor: {
      type: Number,
      required() { return this.catalogVersion === 2; },
      min: [0, 'MRP per piece cannot be negative'],
      validate: {
        validator: isNonNegativeSafeInteger,
        message: 'MRP per piece must be a non-negative safe integer',
      },
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
      required: true,
      index: true,
    },

    // Legacy fields remain mapped for migration validation and historical code.
    // New APIs never accept or write them.
    productName: { type: String, trim: true },
    productCode: { type: String, trim: true },
    title: { type: String, trim: true },
    mrp: { type: Number },
    fit: { type: String, trim: true },
    patternWash: { type: String, trim: true },
    fabric: { type: String, trim: true },
    sleeves: { type: String, trim: true },
    waist: { type: String, trim: true },
    images: { type: [String], default: undefined },
  },
  { timestamps: true },
);

productSchema.index(
  { category: 1, subCategory: 1, status: 1, createdAt: -1 },
  { name: 'products_by_catalog_filters_and_date' },
);

module.exports = mongoose.model('Product', productSchema);
