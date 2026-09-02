const mongoose = require('mongoose');
const { normalizeSku } = require('../../utils/sku');
const { isValidPhone, normalizePhone } = require('../users/account.utils');
const {
  GST_PERCENT,
  ORDER_ACTIVITY_TYPES,
  ORDER_ACTOR_ROLES,
  ORDER_CANCELLED_BY,
  ORDER_NUMBER_PATTERN,
  ORDER_PRICING_VERSION,
  ORDER_SOURCE_ROLES,
  ORDER_STATUSES,
} = require('./order.constants');

const isNonNegativeSafeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const isPositiveSafeInteger = (value) => Number.isSafeInteger(value) && value > 0;
const minorField = (label, { immutable = false } = {}) => ({
  type: Number, required: true, min: [0, `${label} cannot be negative`], immutable,
  validate: { validator: isNonNegativeSafeInteger, message: `${label} must be integer minor units` },
});
const sameId = (left, right) => left != null && right != null && String(left) === String(right);

const orderItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, immutable: true },
  productColourId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductColour', required: true, immutable: true },
  skuId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductVariant', required: true, immutable: true },
  sku: { type: String, required: true, immutable: true, set: normalizeSku, maxlength: 255 },
  productName: { type: String, required: true, trim: true, immutable: true, maxlength: 150 },
  colour: { type: String, required: true, trim: true, immutable: true, maxlength: 150 },
  sizeSetLabel: { type: String, required: true, trim: true, immutable: true, maxlength: 150 },
  sizes: {
    type: [{ type: String, trim: true, maxlength: 50 }], required: true, immutable: true,
    validate: { validator: (sizes) => sizes.length > 0 && new Set(sizes).size === sizes.length, message: 'Snapshot sizes must be non-empty and unique' },
  },
  piecesPerSet: { type: Number, required: true, immutable: true, min: 1, validate: { validator: isPositiveSafeInteger, message: 'Pieces per Set must be a positive whole number' } },
  mrpPerPieceMinor: minorField('MRP per piece', { immutable: true }),
  setMrpMinor: minorField('Set MRP', { immutable: true }),
  originalSetQty: { type: Number, required: true, immutable: true, min: 1, validate: { validator: isPositiveSafeInteger, message: 'Original Set quantity must be positive' } },
  currentSetQty: { type: Number, required: true, min: 0, validate: { validator: isNonNegativeSafeInteger, message: 'Current Set quantity must be non-negative' } },
  originalPieceQty: { type: Number, required: true, immutable: true, min: 1, validate: { validator: isPositiveSafeInteger, message: 'Original piece quantity must be positive' } },
  currentPieceQty: { type: Number, required: true, min: 0, validate: { validator: isNonNegativeSafeInteger, message: 'Current piece quantity must be non-negative' } },
  originalLineGrossMinor: minorField('Original line gross', { immutable: true }),
  currentLineGrossMinor: minorField('Current line gross'),
  isRemoved: { type: Boolean, required: true, default: false },
}, { _id: true });

orderItemSchema.pre('validate', function validateSnapshotMath() {
  if (this.sizes.length !== this.piecesPerSet) this.invalidate('piecesPerSet', 'Pieces per Set must equal snapshot sizes length');
  if (this.setMrpMinor !== this.mrpPerPieceMinor * this.piecesPerSet) this.invalidate('setMrpMinor', 'Set MRP snapshot is inconsistent');
  if (this.originalPieceQty !== this.originalSetQty * this.piecesPerSet) this.invalidate('originalPieceQty', 'Original piece quantity is inconsistent');
  if (this.currentPieceQty !== this.currentSetQty * this.piecesPerSet) this.invalidate('currentPieceQty', 'Current piece quantity is inconsistent');
  if (this.originalLineGrossMinor !== this.setMrpMinor * this.originalSetQty) this.invalidate('originalLineGrossMinor', 'Original line gross is inconsistent');
  if (this.currentLineGrossMinor !== this.setMrpMinor * this.currentSetQty) this.invalidate('currentLineGrossMinor', 'Current line gross is inconsistent');
  if (this.isRemoved !== (this.currentSetQty === 0)) this.invalidate('isRemoved', 'Removed state must match current Set quantity');
});

const addressSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 150 },
  phone: { type: String, required: true, set: normalizePhone, validate: { validator: isValidPhone, message: 'Delivery phone is invalid' } },
  addressLine1: { type: String, required: true, trim: true, maxlength: 255 },
  addressLine2: { type: String, trim: true, default: '', maxlength: 255 },
  city: { type: String, required: true, trim: true, maxlength: 100 },
  state: { type: String, required: true, trim: true, maxlength: 100 },
  postalCode: { type: String, required: true, trim: true, maxlength: 20 },
}, { _id: false });

const itemChangeSchema = new mongoose.Schema({
  orderItemId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  skuId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductVariant', required: true, immutable: true },
  sku: { type: String, required: true, immutable: true, set: normalizeSku },
  beforeSetQty: { type: Number, required: true, immutable: true, min: 0, validate: { validator: isNonNegativeSafeInteger, message: 'Previous Set quantity is invalid' } },
  afterSetQty: { type: Number, required: true, immutable: true, min: 0, validate: { validator: isNonNegativeSafeInteger, message: 'New Set quantity is invalid' } },
}, { _id: false });

const historySchema = new mongoose.Schema({
  type: { type: String, enum: ORDER_ACTIVITY_TYPES, required: true, immutable: true },
  performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  performedByRole: { type: String, enum: ORDER_ACTOR_ROLES, required: true, immutable: true },
  timestamp: { type: Date, required: true, default: Date.now, immutable: true },
  previousStatus: { type: String, enum: [...ORDER_STATUSES, null], default: null, immutable: true },
  newStatus: { type: String, enum: ORDER_STATUSES, required: true, immutable: true },
  reason: { type: String, trim: true, maxlength: 1000, immutable: true },
  itemChanges: { type: [itemChangeSchema], default: [], immutable: true },
}, { _id: true });

const transitions = {
  WHOLESALER_ACCEPTED: ['wholesaler', 'PENDING_WHOLESALER', 'PENDING_ADMIN'],
  WHOLESALER_ADJUSTED: ['wholesaler', 'PENDING_WHOLESALER', 'PENDING_WHOLESALER'],
  ADMIN_ADJUSTED: ['admin', 'PENDING_ADMIN', 'PENDING_ADMIN'],
  RETAILER_CANCELLED: ['retailer', 'PENDING_WHOLESALER', 'CANCELLED'],
  WHOLESALER_CANCELLED: ['wholesaler', null, 'CANCELLED'],
  ADMIN_CANCELLED: ['admin', 'PENDING_ADMIN', 'CANCELLED'],
  ADMIN_CONFIRMED: ['admin', 'PENDING_ADMIN', 'CONFIRMED'],
};

historySchema.pre('validate', function validateTransition() {
  if (this.type === 'CREATED') {
    if (this.previousStatus !== null || !['PENDING_WHOLESALER', 'PENDING_ADMIN'].includes(this.newStatus)) this.invalidate('newStatus', 'Created activity must start a pending order');
    if (this.itemChanges.length) this.invalidate('itemChanges', 'Created activity cannot contain adjustments');
    return;
  }
  const transition = transitions[this.type];
  if (!transition) return;
  const [role, previous, next] = transition;
  if (this.performedByRole !== role) this.invalidate('performedByRole', `${this.type} requires ${role}`);
  if (previous && this.previousStatus !== previous) this.invalidate('previousStatus', `${this.type} requires ${previous}`);
  if (this.newStatus !== next) this.invalidate('newStatus', `${this.type} requires ${next}`);
  if (this.type === 'WHOLESALER_CANCELLED' && !['PENDING_WHOLESALER', 'PENDING_ADMIN'].includes(this.previousStatus)) this.invalidate('previousStatus', 'Wholesaler cancellation requires a pending order');
  const adjustment = this.type.endsWith('_ADJUSTED');
  if (adjustment !== (this.itemChanges.length > 0)) this.invalidate('itemChanges', adjustment ? 'Adjustment history requires item changes' : 'Only adjustments may contain item changes');
});

const orderSchema = new mongoose.Schema({
  orderNumber: { type: String, required: true, trim: true, uppercase: true, match: ORDER_NUMBER_PATTERN, immutable: true },
  sourceRole: { type: String, enum: ORDER_SOURCE_ROLES, required: true, immutable: true },
  placedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  idempotencyKey: { type: String, trim: true, maxlength: 128, immutable: true, select: false },
  requestFingerprint: { type: String, match: /^[a-f\d]{64}$/, immutable: true, select: false },
  wholesaler: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  retailer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, immutable: true },
  status: { type: String, enum: ORDER_STATUSES, required: true },
  pricingVersion: { type: String, required: true, default: ORDER_PRICING_VERSION, immutable: true },
  items: {
    type: [orderItemSchema], required: true,
    validate: [
      { validator: (items) => items.length > 0, message: 'An Order must retain its original items' },
      { validator: (items) => items.some(({ isRemoved }) => !isRemoved), message: 'An Order must retain one active item' },
      { validator: (items) => new Set(items.map(({ skuId }) => String(skuId))).size === items.length, message: 'Duplicate SKUs are not allowed' },
    ],
  },
  deliveryAddress: { type: addressSchema, required: true },
  grossAmountMinor: minorField('Gross amount'),
  discountPercent: { type: Number, required: true, min: 0, max: 100, immutable: true, validate: { validator: Number.isFinite, message: 'Discount percent must be finite' } },
  discountAmountMinor: minorField('Discount amount'),
  taxableAmountMinor: minorField('Taxable amount'),
  gstPercent: { type: Number, required: true, enum: [GST_PERCENT], immutable: true },
  gstAmountMinor: minorField('GST amount'),
  finalAmountMinor: minorField('Final amount'),
  confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  confirmedAt: { type: Date },
  cancelledBy: { type: String, enum: ORDER_CANCELLED_BY },
  cancellationReason: { type: String, trim: true, maxlength: 1000 },
  history: { type: [historySchema], required: true, validate: { validator: (history) => history.length > 0, message: 'Order history is required' } },
}, { timestamps: true, optimisticConcurrency: true });

orderSchema.pre('validate', function validateOrder() {
  if (!this.items.length || !this.history.length) return;
  const first = this.history[0];
  const last = this.history[this.history.length - 1];
  const initial = this.sourceRole === 'retailer' ? 'PENDING_WHOLESALER' : 'PENDING_ADMIN';
  if (Boolean(this.idempotencyKey) !== Boolean(this.requestFingerprint)) this.invalidate('idempotencyKey', 'Idempotency fields must be stored together');
  if (first.type !== 'CREATED' || first.newStatus !== initial || first.performedByRole !== this.sourceRole || !sameId(first.performedBy, this.placedBy)) this.invalidate('history', 'First history entry is inconsistent');
  for (let index = 1; index < this.history.length; index += 1) if (this.history[index].previousStatus !== this.history[index - 1].newStatus) this.invalidate('history', 'History status chain is broken');
  if (last.newStatus !== this.status) this.invalidate('status', 'Status must match latest history');
  if (this.sourceRole === 'retailer' && (!this.retailer || !sameId(this.placedBy, this.retailer))) this.invalidate('retailer', 'Retailer Order ownership is invalid');
  if (this.sourceRole === 'wholesaler' && (this.retailer || !sameId(this.placedBy, this.wholesaler))) this.invalidate('wholesaler', 'Wholesaler Order ownership is invalid');
  if (this.status === 'CANCELLED' && (!this.cancelledBy || !last.type.endsWith('_CANCELLED'))) this.invalidate('cancelledBy', 'Cancellation audit is required');
  if (this.status !== 'CANCELLED' && (this.cancelledBy || this.cancellationReason)) this.invalidate('cancelledBy', 'Cancellation data is only valid for cancelled Orders');
  if (this.status === 'CONFIRMED' && (!this.confirmedBy || !this.confirmedAt || last.type !== 'ADMIN_CONFIRMED')) this.invalidate('confirmedBy', 'Confirmation audit is required');
  if (this.status !== 'CONFIRMED' && (this.confirmedBy || this.confirmedAt)) this.invalidate('confirmedBy', 'Confirmation data is only valid for confirmed Orders');
  const gross = this.items.reduce((sum, item) => sum + item.currentLineGrossMinor, 0);
  if (gross !== this.grossAmountMinor) this.invalidate('grossAmountMinor', 'Gross amount does not match item snapshots');
  if (this.taxableAmountMinor !== this.grossAmountMinor - this.discountAmountMinor) this.invalidate('taxableAmountMinor', 'Taxable amount is inconsistent');
  if (this.finalAmountMinor !== this.taxableAmountMinor + this.gstAmountMinor) this.invalidate('finalAmountMinor', 'Final amount is inconsistent');
});

orderSchema.index({ orderNumber: 1 }, { unique: true, name: 'unique_order_number' });
orderSchema.index({ placedBy: 1, idempotencyKey: 1 }, { unique: true, name: 'unique_order_idempotency_key', partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
orderSchema.index({ wholesaler: 1, status: 1, createdAt: -1 }, { name: 'orders_by_wholesaler_status_date' });
orderSchema.index({ retailer: 1, status: 1, createdAt: -1 }, { name: 'orders_by_retailer_status_date' });

module.exports = mongoose.model('Order', orderSchema);
