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

const wholesalerIdParamsSchema = z
  .object({
    id: objectIdSchema('Wholesaler ID'),
  })
  .strict();

const createWholesalerBodySchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    phone: phoneSchema.optional(),
    discountPercent: discountPercentSchema.optional(),
  })
  .strict();

const updateWholesalerBodySchema = z
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

const updateWholesalerStatusBodySchema = z
  .object({
    status: managedStatusSchema,
  })
  .strict();

const listWholesalersQuerySchema = z
  .object({
    ...paginationFields,
    search: searchSchema,
    status: managedStatusSchema.optional(),
  })
  .strict();

module.exports = {
  createWholesalerSchema: { body: createWholesalerBodySchema },
  listWholesalersSchema: { query: listWholesalersQuerySchema },
  updateWholesalerSchema: {
    params: wholesalerIdParamsSchema,
    body: updateWholesalerBodySchema,
  },
  updateWholesalerStatusSchema: {
    params: wholesalerIdParamsSchema,
    body: updateWholesalerStatusBodySchema,
  },
  wholesalerIdSchema: { params: wholesalerIdParamsSchema },
};
