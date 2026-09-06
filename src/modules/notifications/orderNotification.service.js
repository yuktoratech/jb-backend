const NotificationOutbox = require('./notificationOutbox.model');
const { dispatchOutbox } = require('./notificationDispatch.service');

const COPY = {
  RETAILER_ORDER_SUBMITTED: ['New Retailer order', 'A Retailer order is awaiting your review.'],
  WHOLESALER_ORDER_ADJUSTED: ['Order updated', 'Your Wholesaler adjusted your order.'],
  WHOLESALER_ORDER_FORWARDED: ['Order forwarded', 'Your order was forwarded to Admin.'],
  WHOLESALER_ORDER_CANCELLED: ['Order cancelled', 'Your Wholesaler cancelled your order.'],
  ADMIN_ORDER_ADJUSTED: ['Order updated', 'Admin adjusted an order.'],
  ADMIN_ORDER_CANCELLED: ['Order cancelled', 'Admin cancelled an order.'],
  ADMIN_ORDER_CONFIRMED: ['Order confirmed', 'Admin confirmed an order.'],
};

const enqueueOrderEvent = async ({ eventType, order, recipientUserIds }) => {
  const recipients = [...new Set(recipientUserIds.filter(Boolean).map((id) => id.toString()))];
  if (!recipients.length) return null;
  const [title, body] = COPY[eventType];
  if (!title) throw new Error(`Unsupported notification event: ${eventType}`);
  const outbox = await NotificationOutbox.create({
    eventType,
    recipientUserIds: recipients,
    payload: {
      eventType,
      orderId: order._id.toString(),
      orderNumber: order.orderNumber,
      orderStatus: order.status,
      originRole: order.sourceRole,
    },
    title,
    body,
  });
  return dispatchOutbox(outbox._id);
};

const safelyNotifyOrderEvent = async (event) => {
  try { return await enqueueOrderEvent(event); }
  catch (error) {
    console.error(`Notification event ${event.eventType} failed after business persistence`, error);
    return null;
  }
};

module.exports = { enqueueOrderEvent, safelyNotifyOrderEvent };
