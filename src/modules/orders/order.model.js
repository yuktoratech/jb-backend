const mongoose = require('mongoose');

const { normalizeSku } = require('../../utils/sku');
const {
  isValidPhone,
  normalizePhone,
} = require('../users/account.utils');
const { normalizeShelf } = require('../inventory/inventory.utils');
const {
  calculateDiscountedUnitMinor,
} = require('./orderMoney.utils');
const {
  MONEY_SCALE,
  ORDER_ACTIVITY_TYPES,
  ORDER_ACTOR_ROLES,
  ORDER_INVENTORY_STATUSES,
  ORDER_NUMBER_PATTERN,
  ORDER_PRICING_VERSION,
  ORDER_REJECTED_BY,
  ORDER_SOURCE_ROLES,
  ORDER_STATUSES,
} = require('./order.constants');

const isPositiveSafeInteger = (value) =>
  Number.isSafeInteger(value) && value > 0;

const isNonNegativeSafeInteger = (value) =>
  Number.isSafeInteger(value) && value >= 0;

const roundMoney = (value) => {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return value;
  }

  return Math.round((numericValue + Number.EPSILON) * MONEY_SCALE) / MONEY_SCALE;
};

const toMinorUnits = (value) => Math.round(Number(value) * MONEY_SCALE);

const isValidMoney = (value) =>
  Number.isFinite(value) &&
  value >= 0 &&
  Number.isSafeInteger(toMinorUnits(value)) &&
  Math.abs(value - toMinorUnits(value) / MONEY_SCALE) < Number.EPSILON * 10;

const moneyField = (label) => ({
  type: Number,
  required: true,
  min: [0, `${label} cannot be negative`],
  set: roundMoney,
  validate: {
    validator: isValidMoney,
    message: `${label} must be a valid amount with at most two decimal places`,
  },
});

const normalizeOptionalText = (value) => {
  if (value === undefined || value === null) {
    return undefined;
  }

  const normalized = String(value).trim();
  return normalized || undefined;
};

const sameId = (left, right) =>
  left !== undefined &&
  left !== null &&
  right !== undefined &&
  right !== null &&
  String(left) === String(right);

const inventoryAllocationSchema = new mongoose.Schema(
  {
    shelf: {
      type: String,
      required: [true, 'Allocation shelf is required'],
      set: normalizeShelf,
      maxlength: [100, 'Allocation shelf cannot exceed 100 characters'],
    },
    quantity: {
      type: Number,
      required: true,
      min: [1, 'Allocated quantity must be greater than zero'],
      validate: {
        validator: isPositiveSafeInteger,
        message: 'Allocated quantity must be a positive whole number',
      },
    },
  },
  { _id: false },
);

const orderItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      immutable: true,
    },
    variantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProductVariant',
      required: true,
      immutable: true,
    },
    sku: {
      type: String,
      required: true,
      set: normalizeSku,
      immutable: true,
      maxlength: [255, 'SKU cannot exceed 255 characters'],
    },
    productName: {
      type: String,
      required: true,
      trim: true,
      immutable: true,
      maxlength: [255, 'Product name cannot exceed 255 characters'],
    },
    productCode: {
      type: String,
      set: normalizeOptionalText,
      immutable: true,
      maxlength: [100, 'Product code cannot exceed 100 characters'],
    },
    productTitle: {
      type: String,
      required: true,
      trim: true,
      immutable: true,
      maxlength: [300, 'Product title cannot exceed 300 characters'],
    },
    color: {
      type: String,
      required: true,
      trim: true,
      immutable: true,
      maxlength: [100, 'Color cannot exceed 100 characters'],
    },
    sizeSet: {
      type: String,
      required: true,
      trim: true,
      immutable: true,
      maxlength: [100, 'Size set cannot exceed 100 characters'],
    },
    isRemoved: {
      type: Boolean,
      required: true,
      default: false,
    },
    quantity: {
      type: Number,
      required: true,
      min: [0, 'Order item quantity cannot be negative'],
      validate: {
        validator(value) {
          return this.isRemoved
            ? value === 0
            : isPositiveSafeInteger(value);
        },
        message:
          'Active item quantity must be positive and removed item quantity must be zero',
      },
    },
    basePrice: {
      ...moneyField('Base price'),
      immutable: true,
    },
    discountPercent: {
      type: Number,
      required: true,
      min: [0, 'Discount percent cannot be less than zero'],
      max: [100, 'Discount percent cannot exceed 100'],
      immutable: true,
      validate: {
        validator: Number.isFinite,
        message: 'Discount percent must be a finite number',
      },
    },
    unitPrice: {
      ...moneyField('Unit price'),
      immutable: true,
    },
    lineSubtotal: moneyField('Line subtotal'),
    discountAmount: moneyField('Line discount amount'),
    lineTotal: moneyField('Line total'),
    inventoryAllocation: {
      type: [inventoryAllocationSchema],
      required: true,
      validate: [
        {
          validator(allocations) {
            return this.isRemoved
              ? allocations.length === 0
              : allocations.length > 0;
          },
          message:
            'Active items require allocations and removed items cannot retain allocations',
        },
        {
          validator: (allocations) => {
            const shelves = allocations.map(({ shelf }) => shelf);
            return new Set(shelves).size === shelves.length;
          },
          message: 'An order item cannot contain duplicate shelf allocations',
        },
      ],
    },
  },
  { _id: true },
);

orderItemSchema.pre('validate', function validateItemCalculations() {
  const hasValidQuantity = this.isRemoved
    ? this.quantity === 0
    : isPositiveSafeInteger(this.quantity);

  if (
    !hasValidQuantity ||
    !isValidMoney(this.basePrice) ||
    !isValidMoney(this.unitPrice) ||
    !Number.isFinite(this.discountPercent) ||
    this.discountPercent < 0 ||
    this.discountPercent > 100
  ) {
    return;
  }

  const basePrice = toMinorUnits(this.basePrice);
  const unitPrice = toMinorUnits(this.unitPrice);
  const expectedUnitPrice = calculateDiscountedUnitMinor(
    basePrice,
    this.discountPercent,
  );
  const expectedLineSubtotal = this.isRemoved
    ? 0
    : basePrice * this.quantity;
  const expectedLineTotal = this.isRemoved
    ? 0
    : unitPrice * this.quantity;
  const expectedDiscountAmount = expectedLineSubtotal - expectedLineTotal;
  const allocatedQuantity = this.inventoryAllocation.reduce(
    (total, allocation) => total + allocation.quantity,
    0,
  );

  if (unitPrice > basePrice) {
    this.invalidate('unitPrice', 'Unit price cannot exceed base price');
  }

  if (unitPrice !== expectedUnitPrice) {
    this.invalidate(
      'unitPrice',
      'Unit price does not match base price and discount percent',
    );
  }

  if (toMinorUnits(this.lineSubtotal) !== expectedLineSubtotal) {
    this.invalidate(
      'lineSubtotal',
      'Line subtotal does not match base price and quantity',
    );
  }

  if (toMinorUnits(this.lineTotal) !== expectedLineTotal) {
    this.invalidate(
      'lineTotal',
      'Line total does not match unit price and quantity',
    );
  }

  if (toMinorUnits(this.discountAmount) !== expectedDiscountAmount) {
    this.invalidate(
      'discountAmount',
      'Line discount amount does not match line pricing',
    );
  }

  if (allocatedQuantity !== this.quantity) {
    this.invalidate(
      'inventoryAllocation',
      'Allocated inventory must equal the order item quantity',
    );
  }
});

const deliveryAddressSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: [150, 'Delivery name cannot exceed 150 characters'],
    },
    phone: {
      type: String,
      required: true,
      set: normalizePhone,
      validate: {
        validator: isValidPhone,
        message: 'Delivery phone must contain 7 to 15 digits',
      },
    },
    addressLine1: {
      type: String,
      required: true,
      trim: true,
      maxlength: [255, 'Address line 1 cannot exceed 255 characters'],
    },
    addressLine2: {
      type: String,
      trim: true,
      default: '',
      maxlength: [255, 'Address line 2 cannot exceed 255 characters'],
    },
    city: {
      type: String,
      required: true,
      trim: true,
      maxlength: [100, 'City cannot exceed 100 characters'],
    },
    state: {
      type: String,
      required: true,
      trim: true,
      maxlength: [100, 'State cannot exceed 100 characters'],
    },
    postalCode: {
      type: String,
      required: true,
      trim: true,
      maxlength: [20, 'Postal code cannot exceed 20 characters'],
    },
  },
  { _id: false },
);

const itemQuantityChangeSchema = new mongoose.Schema(
  {
    orderItemId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    variantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProductVariant',
      required: true,
      immutable: true,
    },
    sku: {
      type: String,
      required: true,
      set: normalizeSku,
      immutable: true,
    },
    beforeQuantity: {
      type: Number,
      required: true,
      min: [0, 'Previous quantity cannot be negative'],
      immutable: true,
      validate: {
        validator: isNonNegativeSafeInteger,
        message: 'Previous quantity must be a non-negative whole number',
      },
    },
    afterQuantity: {
      type: Number,
      required: true,
      min: [0, 'New quantity cannot be negative'],
      immutable: true,
      validate: {
        validator: isNonNegativeSafeInteger,
        message: 'New quantity must be a non-negative whole number',
      },
    },
  },
  { _id: false },
);

const orderHistorySchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ORDER_ACTIVITY_TYPES,
      required: true,
      immutable: true,
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    performedByRole: {
      type: String,
      enum: ORDER_ACTOR_ROLES,
      required: true,
      immutable: true,
    },
    timestamp: {
      type: Date,
      required: true,
      default: Date.now,
      immutable: true,
    },
    previousStatus: {
      type: String,
      enum: [...ORDER_STATUSES, null],
      default: null,
      immutable: true,
    },
    newStatus: {
      type: String,
      enum: ORDER_STATUSES,
      required: true,
      immutable: true,
    },
    reason: {
      type: String,
      trim: true,
      maxlength: [1000, 'History reason cannot exceed 1000 characters'],
      immutable: true,
    },
    note: {
      type: String,
      trim: true,
      maxlength: [1000, 'History note cannot exceed 1000 characters'],
      immutable: true,
    },
    itemChanges: {
      type: [itemQuantityChangeSchema],
      default: [],
      immutable: true,
    },
  },
  { _id: true },
);

const activityTransitions = {
  WHOLESALER_CONFIRMED: ['wholesaler', 'PENDING_WHOLESALER', 'PENDING_ADMIN'],
  WHOLESALER_REJECTED: ['wholesaler', 'PENDING_WHOLESALER', 'REJECTED'],
  WHOLESALER_ADJUSTED: ['wholesaler', 'PENDING_WHOLESALER', 'PENDING_WHOLESALER'],
  ADMIN_CONFIRMED: ['admin', 'PENDING_ADMIN', 'CONFIRMED'],
  ADMIN_REJECTED: ['admin', 'PENDING_ADMIN', 'REJECTED'],
  ADMIN_ADJUSTED: ['admin', 'PENDING_ADMIN', 'PENDING_ADMIN'],
};

orderHistorySchema.pre('validate', function validateActivityTransition() {
  if (this.type === 'CREATED') {
    if (this.previousStatus !== null) {
      this.invalidate(
        'previousStatus',
        'Created activity must not have a previous status',
      );
    }

    if (!['PENDING_WHOLESALER', 'PENDING_ADMIN'].includes(this.newStatus)) {
      this.invalidate('newStatus', 'Created activity must start a pending order');
    }

    if (this.itemChanges.length > 0) {
      this.invalidate(
        'itemChanges',
        'Created activity cannot contain item adjustments',
      );
    }

    return;
  }

  const transition = activityTransitions[this.type];

  if (!transition) {
    return;
  }

  const [actorRole, previousStatus, newStatus] = transition;

  if (this.performedByRole !== actorRole) {
    this.invalidate(
      'performedByRole',
      `${this.type} must be performed by an ${actorRole}`,
    );
  }

  if (this.previousStatus !== previousStatus) {
    this.invalidate(
      'previousStatus',
      `${this.type} requires previous status ${previousStatus}`,
    );
  }

  if (this.newStatus !== newStatus) {
    this.invalidate('newStatus', `${this.type} requires new status ${newStatus}`);
  }

  const isAdjustment = this.type.endsWith('_ADJUSTED');

  if (isAdjustment && this.itemChanges.length === 0) {
    this.invalidate(
      'itemChanges',
      'An adjustment activity must record at least one item change',
    );
  }

  if (!isAdjustment && this.itemChanges.length > 0) {
    this.invalidate(
      'itemChanges',
      'Item changes are only allowed for adjustment activities',
    );
  }
});

const orderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      match: [ORDER_NUMBER_PATTERN, 'Order number format is invalid'],
      immutable: true,
    },
    sourceRole: {
      type: String,
      enum: ORDER_SOURCE_ROLES,
      required: true,
      immutable: true,
    },
    placedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    idempotencyKey: {
      type: String,
      trim: true,
      maxlength: [128, 'Idempotency key cannot exceed 128 characters'],
      immutable: true,
      select: false,
    },
    requestFingerprint: {
      type: String,
      match: [/^[a-f\d]{64}$/, 'Request fingerprint format is invalid'],
      immutable: true,
      select: false,
    },
    wholesaler: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    retailer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      immutable: true,
    },
    status: {
      type: String,
      enum: ORDER_STATUSES,
      required: true,
    },
    inventoryStatus: {
      type: String,
      enum: ORDER_INVENTORY_STATUSES,
      required: true,
      default: 'RESERVED',
    },
    pricingVersion: {
      type: String,
      required: true,
      default: ORDER_PRICING_VERSION,
      immutable: true,
      maxlength: [100, 'Pricing version cannot exceed 100 characters'],
    },
    items: {
      type: [orderItemSchema],
      required: true,
      validate: [
        {
          validator: (items) => items.length > 0,
          message: 'An order must contain at least one item',
        },
        {
          validator: (items) => items.some(({ isRemoved }) => !isRemoved),
          message: 'An order must contain at least one active item',
        },
        {
          validator: (items) => {
            const variantIds = items.map(({ variantId }) => String(variantId));
            return new Set(variantIds).size === variantIds.length;
          },
          message: 'An order cannot contain duplicate variants',
        },
      ],
    },
    deliveryAddress: {
      type: deliveryAddressSchema,
      required: true,
    },
    subtotal: moneyField('Order subtotal'),
    discountAmount: moneyField('Order discount amount'),
    totalAmount: moneyField('Order total amount'),
    totalPieces: {
      type: Number,
      required: true,
      min: [1, 'Total pieces must be greater than zero'],
      validate: {
        validator: isPositiveSafeInteger,
        message: 'Total pieces must be a positive whole number',
      },
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [2000, 'Order notes cannot exceed 2000 characters'],
    },
    rejectedBy: {
      type: String,
      enum: ORDER_REJECTED_BY,
    },
    rejectionReason: {
      type: String,
      trim: true,
      maxlength: [1000, 'Rejection reason cannot exceed 1000 characters'],
    },
    history: {
      type: [orderHistorySchema],
      required: true,
      validate: {
        validator: (history) => history.length > 0,
        message: 'Order history must contain the creation activity',
      },
    },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
  },
);

orderSchema.pre('validate', function validateOrderInvariants() {
  if (!this.items.length || !this.history.length) {
    return;
  }

  const firstActivity = this.history[0];
  const lastActivity = this.history[this.history.length - 1];
  const expectedInitialStatus =
    this.sourceRole === 'retailer' ? 'PENDING_WHOLESALER' : 'PENDING_ADMIN';

  if (Boolean(this.idempotencyKey) !== Boolean(this.requestFingerprint)) {
    this.invalidate(
      'idempotencyKey',
      'Idempotency key and request fingerprint must be stored together',
    );
  }

  if (this.sourceRole === 'retailer') {
    if (!this.retailer) {
      this.invalidate('retailer', 'Retailer is required for a retailer order');
    }

    if (!sameId(this.placedBy, this.retailer)) {
      this.invalidate('placedBy', 'A retailer order must be placed by its retailer');
    }
  }

  if (this.sourceRole === 'wholesaler') {
    if (this.retailer) {
      this.invalidate('retailer', 'Retailer must be empty for a wholesaler order');
    }

    if (!sameId(this.placedBy, this.wholesaler)) {
      this.invalidate(
        'placedBy',
        'A wholesaler order must be placed by its wholesaler',
      );
    }
  }

  if (
    firstActivity.type !== 'CREATED' ||
    firstActivity.previousStatus !== null ||
    firstActivity.newStatus !== expectedInitialStatus ||
    firstActivity.performedByRole !== this.sourceRole ||
    !sameId(firstActivity.performedBy, this.placedBy)
  ) {
    this.invalidate(
      'history',
      'The first history entry must describe creation by the placing account',
    );
  }

  for (let index = 1; index < this.history.length; index += 1) {
    if (this.history[index].previousStatus !== this.history[index - 1].newStatus) {
      this.invalidate('history', 'Order history contains a broken status chain');
      break;
    }
  }

  if (lastActivity.newStatus !== this.status) {
    this.invalidate('status', 'Order status must match the latest history entry');
  }

  const expectedInventoryStatus = {
    PENDING_WHOLESALER: 'RESERVED',
    PENDING_ADMIN: 'RESERVED',
    CONFIRMED: 'DEDUCTED',
    REJECTED: 'RELEASED',
  }[this.status];

  if (this.inventoryStatus !== expectedInventoryStatus) {
    this.invalidate(
      'inventoryStatus',
      `Inventory status must be ${expectedInventoryStatus} for ${this.status}`,
    );
  }

  if (this.status === 'REJECTED') {
    const expectedRejectedBy =
      lastActivity.type === 'WHOLESALER_REJECTED' ? 'wholesaler' : 'admin';

    if (!this.rejectedBy) {
      this.invalidate('rejectedBy', 'Rejected by is required for a rejected order');
    } else if (this.rejectedBy !== expectedRejectedBy) {
      this.invalidate(
        'rejectedBy',
        'Rejected by must match the final rejection activity',
      );
    }

    if (
      (this.rejectionReason || undefined) !==
      (lastActivity.reason || undefined)
    ) {
      this.invalidate(
        'rejectionReason',
        'Rejection reason must match the final rejection activity',
      );
    }
  }

  if (this.status !== 'REJECTED' && (this.rejectedBy || this.rejectionReason)) {
    this.invalidate(
      'rejectedBy',
      'Rejection details are only allowed for rejected orders',
    );
  }

  const expectedSubtotal = this.items.reduce(
    (total, item) => total + toMinorUnits(item.lineSubtotal),
    0,
  );
  const expectedDiscountAmount = this.items.reduce(
    (total, item) => total + toMinorUnits(item.discountAmount),
    0,
  );
  const expectedTotalAmount = this.items.reduce(
    (total, item) => total + toMinorUnits(item.lineTotal),
    0,
  );
  const expectedTotalPieces = this.items.reduce(
    (total, item) => total + item.quantity,
    0,
  );

  if (toMinorUnits(this.subtotal) !== expectedSubtotal) {
    this.invalidate('subtotal', 'Order subtotal does not match item subtotals');
  }

  if (toMinorUnits(this.discountAmount) !== expectedDiscountAmount) {
    this.invalidate(
      'discountAmount',
      'Order discount amount does not match item discounts',
    );
  }

  if (toMinorUnits(this.totalAmount) !== expectedTotalAmount) {
    this.invalidate('totalAmount', 'Order total amount does not match item totals');
  }

  if (expectedSubtotal - expectedDiscountAmount !== expectedTotalAmount) {
    this.invalidate('totalAmount', 'Order pricing totals are inconsistent');
  }

  if (this.totalPieces !== expectedTotalPieces) {
    this.invalidate('totalPieces', 'Total pieces does not match item quantities');
  }
});

const normalizeForComparison = (value) => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof mongoose.Types.ObjectId) {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map(normalizeForComparison);
  }

  if (value && typeof value.toObject === 'function') {
    return normalizeForComparison(
      value.toObject({ depopulate: true, getters: false, virtuals: false }),
    );
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((normalized, key) => {
        if (value[key] !== undefined) {
          normalized[key] = normalizeForComparison(value[key]);
        }

        return normalized;
      }, {});
  }

  return value;
};

orderSchema.pre('save', async function protectExistingHistoryEntries() {
  if (this.isNew || !this.isModified('history')) {
    return;
  }

  const storedOrder = await this.constructor
    .findById(this._id)
    .select({ history: 1 })
    .lean();

  if (!storedOrder) {
    return;
  }

  const storedHistory = normalizeForComparison(storedOrder.history);
  const currentHistory = normalizeForComparison(this.history);
  const existingEntriesAreUnchanged =
    currentHistory.length >= storedHistory.length &&
    storedHistory.every(
      (entry, index) =>
        JSON.stringify(entry) === JSON.stringify(currentHistory[index]),
    );

  if (!existingEntriesAreUnchanged) {
    const validationError = new mongoose.Error.ValidationError(this);
    validationError.addError(
      'history',
      new mongoose.Error.ValidatorError({
        path: 'history',
        message: 'Order history entries are append-only',
      }),
    );
    throw validationError;
  }
});

const queryHistoryProtection = function protectHistoryFromQueryMutation() {
  const update = this.getUpdate() || {};
  const forbiddenOperators = [
    '$set',
    '$unset',
    '$pull',
    '$pullAll',
    '$pop',
    '$rename',
    '$addToSet',
  ];
  const mutatesExistingHistory =
    Object.prototype.hasOwnProperty.call(update, 'history') ||
    forbiddenOperators.some((operator) =>
      Object.keys(update[operator] || {}).some(
        (path) => path === 'history' || path.startsWith('history.'),
      ),
    ) ||
    Object.keys(update.$push || {}).some((path) => path.startsWith('history.'));

  if (mutatesExistingHistory) {
    throw new Error('Order history entries are append-only');
  }
};

orderSchema.pre('findOneAndUpdate', queryHistoryProtection);
orderSchema.pre('updateOne', queryHistoryProtection);
orderSchema.pre('updateMany', queryHistoryProtection);

orderSchema.index(
  { orderNumber: 1 },
  { unique: true, name: 'unique_order_number' },
);

orderSchema.index(
  { status: 1, createdAt: -1 },
  { name: 'orders_by_status_and_date' },
);

orderSchema.index(
  { wholesaler: 1, status: 1, createdAt: -1 },
  { name: 'orders_by_wholesaler_status_and_date' },
);

orderSchema.index(
  { retailer: 1, status: 1, createdAt: -1 },
  {
    name: 'orders_by_retailer_status_and_date',
    partialFilterExpression: { retailer: { $type: 'objectId' } },
  },
);

orderSchema.index(
  { placedBy: 1, createdAt: -1 },
  { name: 'orders_by_placing_account_and_date' },
);

orderSchema.index(
  { placedBy: 1, idempotencyKey: 1 },
  {
    unique: true,
    name: 'unique_order_idempotency_key_per_account',
    partialFilterExpression: { idempotencyKey: { $type: 'string' } },
  },
);

orderSchema.index(
  { sourceRole: 1, createdAt: -1 },
  { name: 'orders_by_source_role_and_date' },
);

const Order = mongoose.model('Order', orderSchema);

module.exports = Order;
