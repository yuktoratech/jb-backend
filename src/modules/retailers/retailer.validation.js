const { z } = require('zod');

const {
  discountPercentSchema,
  emailSchema,
  managedStatusSchema,
  nameSchema,
  objectIdSchema,
  paginationFields,
  phoneSchema,
  searchSchema,
} = require('../users/account.validation');

const retailerIdParamsSchema = z
  .object({
    id: objectIdSchema('Retailer ID'),
  })
  .strict();

const createRetailerBodySchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    phone: phoneSchema,
    discountPercent: discountPercentSchema.optional(),
  })
  .strict();

const updateRetailerBodySchema = z
  .object({
    name: nameSchema.optional(),
    email: emailSchema.optional(),
    phone: phoneSchema.nullable().optional(),
    discountPercent: discountPercentSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'At least one field is required',
  });

const updateRetailerStatusBodySchema = z
  .object({
    status: managedStatusSchema,
  })
  .strict();

const listRetailersQuerySchema = z
  .object({
    ...paginationFields,
    search: searchSchema,
    status: managedStatusSchema.optional(),
    wholesalerId: objectIdSchema('Wholesaler ID').optional(),
  })
  .strict();

module.exports = {
  createRetailerSchema: { body: createRetailerBodySchema },
  listRetailersSchema: { query: listRetailersQuerySchema },
  retailerIdSchema: { params: retailerIdParamsSchema },
  updateRetailerSchema: {
    params: retailerIdParamsSchema,
    body: updateRetailerBodySchema,
  },
  updateRetailerStatusSchema: {
    params: retailerIdParamsSchema,
    body: updateRetailerStatusBodySchema,
  },
};
