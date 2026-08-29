const { z } = require('zod');

const { normalizeSku } = require('../../utils/sku');
const { normalizeShelf } = require('./inventory.utils');

const ADJUSTMENT_TYPES = ['ADD', 'REMOVE', 'TRANSFER'];
const INVENTORY_STATUSES = ['in_stock', 'out_of_stock'];
const TRANSACTION_SOURCES = ['admin', 'import', 'order', 'system'];
const TRANSACTION_TYPES = [
  ...ADJUSTMENT_TYPES,
  'ORDER_RESERVE',
  'ORDER_RELEASE',
  'ORDER_DEDUCT',
  'MANUAL_ADJUSTMENT',
];

const objectIdSchema = z
  .string({ error: 'Variant ID is required' })
  .trim()
  .regex(/^[a-f\d]{24}$/i, 'A valid variant ID is required');

const canNormalizeSku = (value) => {
  try {
    normalizeSku(value);
    return true;
  } catch (error) {
    return false;
  }
};

const skuSchema = z
  .string({ error: 'SKU is required' })
  .trim()
  .min(1, 'SKU is required')
  .max(255, 'SKU cannot exceed 255 characters')
  .refine(canNormalizeSku, 'SKU must contain letters or numbers')
  .transform(normalizeSku);

const shelfSchema = z
  .string({ error: 'Shelf is required' })
  .trim()
  .min(1, 'Shelf is required')
  .max(100, 'Shelf cannot exceed 100 characters')
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    'Shelf contains unsupported control characters',
  )
  .transform(normalizeShelf);

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

const listInventoryQuerySchema = z
  .object({
    ...paginationFields,
    search: z
      .string({ error: 'Search must be a string' })
      .trim()
      .max(150, 'Search cannot exceed 150 characters')
      .optional(),
    sku: skuSchema.optional(),
    product: z
      .string({ error: 'Product must be a valid ID' })
      .trim()
      .regex(/^[a-f\d]{24}$/i, 'Product must be a valid ID')
      .optional(),
    category: z
      .string({ error: 'Category must be a valid ID' })
      .trim()
      .regex(/^[a-f\d]{24}$/i, 'Category must be a valid ID')
      .optional(),
    stockStatus: z
      .enum(INVENTORY_STATUSES, {
        error: 'Stock status must be in_stock or out_of_stock',
      })
      .optional(),
  })
  .strict();

const adjustmentTypeSchema = z
  .string({ error: 'Adjustment type is required' })
  .trim()
  .min(1, 'Adjustment type is required')
  .transform((value) => value.toUpperCase())
  .pipe(
    z.enum(ADJUSTMENT_TYPES, {
      error: 'Adjustment type must be ADD, REMOVE, or TRANSFER',
    }),
  );

const adjustInventoryBodySchema = z
  .object({
    sku: skuSchema,
    type: adjustmentTypeSchema,
    quantity: z
      .number({ error: 'Quantity must be a number' })
      .int('Quantity must be a whole number')
      .positive('Quantity must be greater than zero')
      .max(Number.MAX_SAFE_INTEGER, 'Quantity is too large'),
    shelf: shelfSchema,
    toShelf: shelfSchema.optional(),
    referenceId: z
      .string({ error: 'Reference ID must be a string' })
      .trim()
      .min(1, 'Reference ID cannot be empty')
      .max(255, 'Reference ID cannot exceed 255 characters')
      .optional(),
    note: z
      .string({ error: 'Note must be a string' })
      .trim()
      .min(1, 'Note cannot be empty')
      .max(1000, 'Note cannot exceed 1000 characters')
      .optional(),
  })
  .strict()
  .superRefine((body, context) => {
    if (body.type === 'TRANSFER' && !body.toShelf) {
      context.addIssue({
        code: 'custom',
        path: ['toShelf'],
        message: 'Destination shelf is required for a transfer',
      });
    }

    if (body.type !== 'TRANSFER' && body.toShelf) {
      context.addIssue({
        code: 'custom',
        path: ['toShelf'],
        message: 'Destination shelf is only allowed for a transfer',
      });
    }

    if (
      body.type === 'TRANSFER' &&
      body.toShelf &&
      body.shelf === body.toShelf
    ) {
      context.addIssue({
        code: 'custom',
        path: ['toShelf'],
        message: 'Source and destination shelves must be different',
      });
    }
  });

const variantIdParamsSchema = z
  .object({
    variantId: objectIdSchema,
  })
  .strict();

const skuParamsSchema = z
  .object({
    sku: skuSchema,
  })
  .strict();

const listTransactionsQuerySchema = z
  .object({
    ...paginationFields,
    type: z
      .enum(TRANSACTION_TYPES, {
        error: 'Transaction type is invalid',
      })
      .optional(),
    source: z
      .enum(TRANSACTION_SOURCES, {
        error: 'Transaction source is invalid',
      })
      .optional(),
  })
  .strict();

module.exports = {
  adjustInventorySchema: { body: adjustInventoryBodySchema },
  inventoryBySkuSchema: { params: skuParamsSchema },
  inventoryByVariantSchema: { params: variantIdParamsSchema },
  listInventorySchema: { query: listInventoryQuerySchema },
  listTransactionsSchema: {
    params: variantIdParamsSchema,
    query: listTransactionsQuerySchema,
  },
};
