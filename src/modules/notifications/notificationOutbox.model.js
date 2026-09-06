const mongoose = require('mongoose');

const EVENT_TYPES = [
  'RETAILER_ORDER_SUBMITTED',
  'WHOLESALER_ORDER_ADJUSTED',
  'WHOLESALER_ORDER_FORWARDED',
  'WHOLESALER_ORDER_CANCELLED',
  'ADMIN_ORDER_ADJUSTED',
  'ADMIN_ORDER_CANCELLED',
  'ADMIN_ORDER_CONFIRMED',
];

const notificationOutboxSchema = new mongoose.Schema({
  eventType: { type: String, enum: EVENT_TYPES, required: true, immutable: true },
  recipientUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true }],
  payload: {
    eventType: { type: String, required: true, immutable: true },
    orderId: { type: String, required: true, immutable: true },
    orderNumber: { type: String, required: true, immutable: true },
    orderStatus: { type: String, required: true, immutable: true },
    originRole: { type: String, enum: ['wholesaler', 'retailer'], required: true, immutable: true },
  },
  title: { type: String, required: true, immutable: true, maxlength: 120 },
  body: { type: String, required: true, immutable: true, maxlength: 300 },
  status: { type: String, enum: ['PENDING', 'DELIVERED', 'PARTIAL', 'FAILED', 'NO_DEVICES'], default: 'PENDING', required: true },
  attempts: { type: Number, min: 0, default: 0, required: true },
  deliveredAt: { type: Date },
  lastError: { type: String, maxlength: 1000 },
}, { timestamps: true, optimisticConcurrency: true });

notificationOutboxSchema.index({ status: 1, createdAt: 1 }, { name: 'notification_outbox_by_status_date' });
notificationOutboxSchema.index({ 'payload.orderId': 1, eventType: 1 }, { name: 'notification_outbox_by_order_event' });

module.exports = mongoose.model('NotificationOutbox', notificationOutboxSchema);
module.exports.EVENT_TYPES = EVENT_TYPES;
