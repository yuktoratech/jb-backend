const { z } = require('zod');
const { deliveryAddressSchema } = require('../addresses/address.validation');
const { ORDER_SOURCE_ROLES, ORDER_STATUSES } = require('./order.constants');

const MAX_ORDER_LINES = 100;
const objectId = (label) => z.string({ error: `${label} is required` }).trim().regex(/^[a-f\d]{24}$/i, `A valid ${label.toLowerCase()} is required`);
const quantity = z.number({ error: 'Set quantity must be a number' }).int('Set quantity must be a whole number').positive('Set quantity must be positive').max(Number.MAX_SAFE_INTEGER);
const adjustedQuantity = z.number({ error: 'Set quantity must be a number' }).int('Set quantity must be a whole number').min(0, 'Set quantity cannot be negative').max(Number.MAX_SAFE_INTEGER);
const reason = z.string().trim().min(1, 'Cancellation reason cannot be empty').max(1000).optional();
const params = z.object({ id: objectId('Order ID') }).strict();
const pagination = { page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) };

const createBody = z.object({
  items: z.array(z.object({ skuId: objectId('SKU ID'), setQuantity: quantity }).strict()).min(1).max(MAX_ORDER_LINES),
  addressId: objectId('Address ID').optional(),
  deliveryAddress: deliveryAddressSchema.optional(),
  saveAddress: z.boolean().optional(),
}).strict().superRefine((body, context) => {
  if (Boolean(body.addressId) === Boolean(body.deliveryAddress)) {
    context.addIssue({ code: 'custom', path: ['deliveryAddress'], message: 'Provide exactly one of addressId or deliveryAddress' });
  }
  if (body.addressId && body.saveAddress !== undefined) {
    context.addIssue({ code: 'custom', path: ['saveAddress'], message: 'saveAddress is only allowed with an inline deliveryAddress' });
  }
  const seen = new Set();
  body.items.forEach((item, index) => {
    if (seen.has(item.skuId)) context.addIssue({ code: 'custom', path: ['items', index, 'skuId'], message: 'Duplicate SKUs are not allowed' });
    seen.add(item.skuId);
  });
});

const adjustBody = z.object({
  items: z.array(z.object({ orderItemId: objectId('Order item ID'), setQuantity: adjustedQuantity }).strict()).min(1).max(MAX_ORDER_LINES),
}).strict().superRefine((body, context) => {
  const seen = new Set();
  body.items.forEach((item, index) => {
    if (seen.has(item.orderItemId)) context.addIssue({ code: 'custom', path: ['items', index, 'orderItemId'], message: 'Duplicate Order item adjustments are not allowed' });
    seen.add(item.orderItemId);
  });
});

module.exports = {
  adjustOrderSchema: { params, body: adjustBody },
  cancelOrderSchema: { params, body: z.object({ reason }).strict() },
  createOrderSchema: { body: createBody },
  listOrdersSchema: { query: z.object({ ...pagination, search: z.string().trim().max(150).optional(), status: z.enum(ORDER_STATUSES).optional(), sourceRole: z.enum(ORDER_SOURCE_ROLES).optional(), wholesalerId: objectId('Wholesaler ID').optional(), retailerId: objectId('Retailer ID').optional() }).strict() },
  orderIdSchema: { params },
};
