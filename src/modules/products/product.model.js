const mongoose = require('mongoose');

const PRODUCT_STATUSES = ['active', 'inactive'];
const PRODUCT_CODE_PATTERN = /^[A-Z0-9]+(?:[-_][A-Z0-9]+)*$/;

const normalizeProductCode = (value) => {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.trim().toUpperCase();
  return normalized || undefined;
};

const productSchema = new mongoose.Schema(
  {
    productName: {
      type: String,
      required: true,
      trim: true,
    },
    productCode: {
      type: String,
      set: normalizeProductCode,
      validate: {
        validator: (value) =>
          value === undefined || PRODUCT_CODE_PATTERN.test(value),
        message:
          'Product code may contain only letters, numbers, hyphens, and underscores',
      },
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
      index: true,
    },
    description: {
      type: String,
      trim: true,
    },
    mrp: {
      type: Number,
      required: true,
      min: [0, 'MRP cannot be negative'],
      validate: {
        validator: Number.isFinite,
        message: 'MRP must be a finite number',
      },
    },
    fit: {
      type: String,
      trim: true,
    },
    patternWash: {
      type: String,
      trim: true,
    },
    fabric: {
      type: String,
      trim: true,
    },
    sleeves: {
      type: String,
      trim: true,
    },
    waist: {
      type: String,
      trim: true,
    },
    images: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      enum: PRODUCT_STATUSES,
      default: 'active',
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

productSchema.index(
  { productCode: 1 },
  {
    unique: true,
    partialFilterExpression: { productCode: { $type: 'string' } },
    name: 'unique_product_code_when_present',
  },
);

const Product = mongoose.model('Product', productSchema);

module.exports = Product;
