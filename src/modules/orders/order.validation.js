const { z } = require('zod');

const {
  isValidPhone,
  normalizePhone,
} = require('../users/account.utils');
const {
  ORDER_SOURCE_ROLES,
  ORDER_STATUSES,
} = require('./order.constants');

const MAX_ORDER_LINES = 100;

const objectIdSchema = (fieldName) =>
  z
    .string({ error: `${fieldName} is required` })
    .trim()
    .regex(/^[a-f\d]{24}$/i, `A valid ${fieldName.toLowerCase()} is required`)
    .transform((value) => value.toLowerCase());

const quantitySchema = z
  .number({ error: 'Quantity must be a number' })
  .int('Quantity must be a whole number')
  .positive('Quantity must be greater than zero')
  .max(Number.MAX_SAFE_INTEGER, 'Quantity is too large');

// Quantity zero is the explicit signal to remove an existing order item.
const adjustmentQuantitySchema = z
  .number({ error: 'Quantity must be a number' })
  .int('Quantity must be a whole number')
  .min(0, 'Quantity cannot be negative')
  .max(Number.MAX_SAFE_INTEGER, 'Quantity is too large');

const optionalNoteSchema = (label, maximumLength) =>
  z
    .string({ error: `${label} must be a string` })
    .trim()
    .min(1, `${label} cannot be empty`)
    .max(maximumLength, `${label} cannot exceed ${maximumLength} characters`)
    .optional();

const normalizedRequiredText = (label, minimumLength, maximumLength) =>
  z
    .string({ error: `${label} is required` })
    .trim()
    .min(minimumLength, `${label} must contain at least ${minimumLength} characters`)
    .max(maximumLength, `${label} cannot exceed ${maximumLength} characters`)
    .transform((value) => value.replace(/\s+/g, ' '));

const phoneSchema = z
  .string({ error: 'Delivery phone is required' })
  .trim()
  .min(1, 'Delivery phone is required')
  .max(30, 'Delivery phone cannot exceed 30 characters')
  .refine(
    (value) => isValidPhone(normalizePhone(value)),
    'Delivery phone must contain 7 to 15 digits with an optional leading +',
  )
  .transform(normalizePhone);

const postalCodeSchema = z
  .string({ error: 'Postal code is required' })
  .trim()
  .min(3, 'Postal code must contain at least 3 characters')
  .max(20, 'Postal code cannot exceed 20 characters')
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9 -]*[A-Za-z0-9]$/,
    'Postal code contains unsupported characters',
  );

const deliveryAddressSchema = z
  .object({
    name: normalizedRequiredText('Delivery name', 2, 150),
    phone: phoneSchema,
    addressLine1: normalizedRequiredText('Address line 1', 3, 255),
    addressLine2: z
      .string({ error: 'Address line 2 must be a string' })
      .trim()
      .max(255, 'Address line 2 cannot exceed 255 characters')
      .default(''),
    city: normalizedRequiredText('City', 2, 100),
    state: normalizedRequiredText('State', 2, 100),
    postalCode: postalCodeSchema,
  })
  .strict();

const createOrderItemSchema = z
  .object({
    variantId: objectIdSchema('Variant ID'),
    quantity: quantitySchema,
  })
  .strict();

const createOrderBodySchema = z
  .object({
    items: z
      .array(createOrderItemSchema, { error: 'Order items are required' })
      .min(1, 'At least one order item is required')
      .max(MAX_ORDER_LINES, `An order cannot exceed ${MAX_ORDER_LINES} items`),
    deliveryAddress: deliveryAddressSchema,
    notes: optionalNoteSchema('Notes', 2000),
  })
  .strict()
  .superRefine((body, context) => {
    const seenVariantIds = new Set();

    body.items.forEach((item, index) => {
      const variantId = item.variantId.toLowerCase();

      if (seenVariantIds.has(variantId)) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'variantId'],
          message: 'Duplicate variants are not allowed in an order',
        });
      }

      seenVariantIds.add(variantId);
    });
  });

const paginationFields = {
  page: z.coerce
    .number({ error: 'Page must be a number' })
    .int('Page must be an integer')
    .min(1, 'Page must be at least 1')
    .default(1),
  limit: z.coerce
    .number({ error: 'Limit must be a number' })
    .int('Limit must be an integer')
    .min(1, 'Limit must be at least 1')
    .max(100, 'Limit cannot exceed 100')
    .default(20),
};

const ISO_DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

const hasValidCalendarDate = (value) => {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
};

const isSupportedIsoDate = (value) => {
  const hasSupportedFormat =
    ISO_DATE_ONLY_PATTERN.test(value) || ISO_DATE_TIME_PATTERN.test(value);

  return (
    hasSupportedFormat &&
    hasValidCalendarDate(value) &&
    !Number.isNaN(Date.parse(value))
  );
};

const dateQuerySchema = (label, { endOfDay = false } = {}) =>
  z
    .string({ error: `${label} must be a date string` })
    .trim()
    .min(1, `${label} cannot be empty`)
    .refine(isSupportedIsoDate, `${label} must be a valid ISO date`)
    .transform((value) => {
      const date = new Date(value);

      if (endOfDay && ISO_DATE_ONLY_PATTERN.test(value)) {
        date.setUTCHours(23, 59, 59, 999);
      }

      return date;
    });

const listOrdersQuerySchema = z
  .object({
    ...paginationFields,
    search: z
      .string({ error: 'Search must be a string' })
      .trim()
      .max(150, 'Search cannot exceed 150 characters')
      .optional(),
    status: z
      .enum(ORDER_STATUSES, { error: 'Order status is invalid' })
      .optional(),
    sourceRole: z
      .enum(ORDER_SOURCE_ROLES, { error: 'Source role is invalid' })
      .optional(),
    dateFrom: dateQuerySchema('Date from').optional(),
    dateTo: dateQuerySchema('Date to', { endOfDay: true }).optional(),
    wholesalerId: objectIdSchema('Wholesaler ID').optional(),
    retailerId: objectIdSchema('Retailer ID').optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo) {
      context.addIssue({
        code: 'custom',
        path: ['dateTo'],
        message: 'Date to must be on or after date from',
      });
    }
  });

const orderIdParamsSchema = z
  .object({
    id: objectIdSchema('Order ID'),
  })
  .strict();

const rejectOrderBodySchema = z
  .object({
    reason: optionalNoteSchema('Reason', 1000),
  })
  .strict();

const adjustOrderItemSchema = z
  .object({
    orderItemId: objectIdSchema('Order item ID'),
    quantity: adjustmentQuantitySchema,
  })
  .strict();

const adjustOrderBodySchema = z
  .object({
    items: z
      .array(adjustOrderItemSchema, { error: 'Adjustment items are required' })
      .min(1, 'At least one item adjustment is required')
      .max(MAX_ORDER_LINES, `An adjustment cannot exceed ${MAX_ORDER_LINES} items`),
    note: optionalNoteSchema('Note', 1000),
  })
  .strict()
  .superRefine((body, context) => {
    const seenItemIds = new Set();

    body.items.forEach((item, index) => {
      const itemId = item.orderItemId.toLowerCase();

      if (seenItemIds.has(itemId)) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'orderItemId'],
          message: 'Duplicate order item adjustments are not allowed',
        });
      }

      seenItemIds.add(itemId);
    });
  });

module.exports = {
  adjustOrderSchema: {
    params: orderIdParamsSchema,
    body: adjustOrderBodySchema,
  },
  createOrderSchema: { body: createOrderBodySchema },
  listOrdersSchema: { query: listOrdersQuerySchema },
  orderIdSchema: { params: orderIdParamsSchema },
  rejectOrderSchema: {
    params: orderIdParamsSchema,
    body: rejectOrderBodySchema,
  },
};
