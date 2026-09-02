const mongoose = require('mongoose');

const { normalizeSku } = require('../../utils/sku');
const {
  normalizeShelf,
  recalculateInventoryTotals,
} = require('./inventory.utils');

const INVENTORY_STATUSES = ['in_stock', 'out_of_stock'];

const isNonNegativeSafeInteger = (value) =>
  Number.isSafeInteger(value) && value >= 0;

const shelfStockSchema = new mongoose.Schema(
  {
    shelf: {
      type: String,
      required: [true, 'Shelf is required'],
      set: normalizeShelf,
      maxlength: [100, 'Shelf must not exceed 100 characters'],
    },
    quantity: {
      type: Number,
      required: true,
      min: [0, 'Shelf quantity cannot be negative'],
      validate: {
        validator: isNonNegativeSafeInteger,
        message: 'Shelf quantity must be a non-negative whole number',
      },
    },
  },
  {
    _id: false,
  },
);

const inventorySchema = new mongoose.Schema(
  {
    variant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProductVariant',
      required: true,
    },
    sku: {
      type: String,
      required: true,
      set: normalizeSku,
    },
    shelves: {
      type: [shelfStockSchema],
      default: [],
      validate: {
        validator: (shelves) => {
          const shelfNames = shelves.map(({ shelf }) => shelf);
          return new Set(shelfNames).size === shelfNames.length;
        },
        message: 'An inventory cannot contain duplicate shelf entries',
      },
    },
    availableQuantity: {
      type: Number,
      required: true,
      default: 0,
      min: [0, 'Available quantity cannot be negative'],
      validate: {
        validator: isNonNegativeSafeInteger,
        message: 'Available quantity must be a non-negative whole number',
      },
    },
    totalQuantity: {
      type: Number,
      required: true,
      default: 0,
      min: [0, 'Total quantity cannot be negative'],
      validate: {
        validator: isNonNegativeSafeInteger,
        message: 'Total quantity must be a non-negative whole number',
      },
    },
    status: {
      type: String,
      enum: INVENTORY_STATUSES,
      required: true,
      default: 'out_of_stock',
    },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
  },
);

inventorySchema.pre('validate', function calculateDerivedInventoryFields() {
  try {
    recalculateInventoryTotals(this);
  } catch (error) {
    this.invalidate('shelves', error.message);
  }
});

inventorySchema.index(
  { variant: 1 },
  { unique: true, name: 'unique_inventory_variant' },
);

inventorySchema.index(
  { sku: 1 },
  { unique: true, name: 'unique_inventory_sku' },
);

inventorySchema.index(
  { status: 1, availableQuantity: 1 },
  { name: 'inventory_status_available_quantity' },
);

const Inventory = mongoose.model('Inventory', inventorySchema);

module.exports = Inventory;
