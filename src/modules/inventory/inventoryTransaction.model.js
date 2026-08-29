const mongoose = require('mongoose');

const { normalizeSku } = require('../../utils/sku');
const { normalizeShelf } = require('./inventory.utils');

const TRANSACTION_TYPES = [
  'ADD',
  'REMOVE',
  'TRANSFER',
  'ORDER_RESERVE',
  'ORDER_RELEASE',
  'ORDER_DEDUCT',
  'MANUAL_ADJUSTMENT',
];

const TRANSACTION_SOURCES = ['admin', 'import', 'order', 'system'];

const normalizeOptionalShelf = (value) =>
  value === undefined || value === null ? undefined : normalizeShelf(value);

const isPositiveSafeInteger = (value) =>
  Number.isSafeInteger(value) && value > 0;

const isNonNegativeSafeInteger = (value) =>
  value === undefined || (Number.isSafeInteger(value) && value >= 0);

const inventoryTransactionSchema = new mongoose.Schema(
  {
    inventory: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Inventory',
      required: true,
    },
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
    type: {
      type: String,
      enum: TRANSACTION_TYPES,
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: [1, 'Transaction quantity must be greater than zero'],
      validate: {
        validator: isPositiveSafeInteger,
        message: 'Transaction quantity must be a positive whole number',
      },
    },
    fromShelf: {
      type: String,
      set: normalizeOptionalShelf,
      maxlength: [100, 'Source shelf must not exceed 100 characters'],
    },
    toShelf: {
      type: String,
      set: normalizeOptionalShelf,
      maxlength: [100, 'Destination shelf must not exceed 100 characters'],
    },
    previousQuantity: {
      type: Number,
      min: [0, 'Previous quantity cannot be negative'],
      validate: {
        validator: isNonNegativeSafeInteger,
        message: 'Previous quantity must be a non-negative whole number',
      },
    },
    newQuantity: {
      type: Number,
      min: [0, 'New quantity cannot be negative'],
      validate: {
        validator: isNonNegativeSafeInteger,
        message: 'New quantity must be a non-negative whole number',
      },
    },
    source: {
      type: String,
      enum: TRANSACTION_SOURCES,
      required: true,
      default: 'admin',
    },
    referenceId: {
      type: String,
      trim: true,
      maxlength: [255, 'Reference id must not exceed 255 characters'],
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    note: {
      type: String,
      trim: true,
      maxlength: [1000, 'Note must not exceed 1000 characters'],
    },
  },
  {
    timestamps: {
      createdAt: true,
      updatedAt: false,
    },
  },
);

inventoryTransactionSchema.pre(
  'validate',
  function validateTransferShelves() {
    if (this.type === 'ADD' && !this.toShelf) {
      this.invalidate('toShelf', 'Destination shelf is required for ADD');
    }

    if (this.type === 'REMOVE' && !this.fromShelf) {
      this.invalidate('fromShelf', 'Source shelf is required for REMOVE');
    }

    if (this.type === 'TRANSFER' && !this.fromShelf) {
      this.invalidate('fromShelf', 'Source shelf is required for TRANSFER');
    }

    if (this.type === 'TRANSFER' && !this.toShelf) {
      this.invalidate('toShelf', 'Destination shelf is required for TRANSFER');
    }

    if (
      this.type === 'TRANSFER' &&
      this.fromShelf &&
      this.toShelf &&
      this.fromShelf === this.toShelf
    ) {
      this.invalidate(
        'toShelf',
        'Source and destination shelves must be different',
      );
    }
  },
);

inventoryTransactionSchema.index(
  { variant: 1, createdAt: -1 },
  { name: 'inventory_transactions_by_variant' },
);

inventoryTransactionSchema.index(
  { sku: 1, createdAt: -1 },
  { name: 'inventory_transactions_by_sku' },
);

inventoryTransactionSchema.index(
  { inventory: 1, createdAt: -1 },
  { name: 'inventory_transactions_by_inventory' },
);

inventoryTransactionSchema.index(
  { source: 1, referenceId: 1 },
  {
    name: 'inventory_transactions_by_source_reference',
    partialFilterExpression: { referenceId: { $type: 'string' } },
  },
);

const InventoryTransaction = mongoose.model(
  'InventoryTransaction',
  inventoryTransactionSchema,
);

module.exports = InventoryTransaction;
