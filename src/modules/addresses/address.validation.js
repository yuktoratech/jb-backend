const { z } = require('zod');
const { isValidPhone, normalizePhone } = require('../users/account.utils');

const normalizedText = (label, min, max) => z
  .string({ error: `${label} is required` })
  .trim()
  .min(min, `${label} must contain at least ${min} characters`)
  .max(max, `${label} cannot exceed ${max} characters`)
  .transform((value) => value.replace(/\s+/g, ' '));

const addressFields = {
  name: normalizedText('Delivery name', 2, 150),
  phone: z.string({ error: 'Delivery phone is required' }).trim()
    .refine((value) => isValidPhone(normalizePhone(value)), 'Delivery phone is invalid')
    .transform(normalizePhone),
  addressLine1: normalizedText('Address line 1', 3, 255),
  addressLine2: z.string({ error: 'Address line 2 must be a string' }).trim().max(255).default(''),
  city: normalizedText('City', 2, 100),
  state: normalizedText('State', 2, 100),
  postalCode: z.string({ error: 'Postal code is required' }).trim().min(3).max(20),
};

const deliveryAddressSchema = z.object(addressFields).strict();
const createAddressBodySchema = z.object({ ...addressFields, isDefault: z.boolean().optional() }).strict();
const updateAddressBodySchema = z.object({
  ...Object.fromEntries(Object.entries(addressFields).map(([key, schema]) => [key, schema.optional()])),
  isDefault: z.boolean().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, 'At least one field is required');
const addressIdParamsSchema = z.object({
  id: z.string({ error: 'Address ID is required' }).trim().regex(/^[a-f\d]{24}$/i, 'A valid address ID is required'),
}).strict();

module.exports = {
  addressIdSchema: { params: addressIdParamsSchema },
  createAddressSchema: { body: createAddressBodySchema },
  deliveryAddressSchema,
  updateAddressSchema: { params: addressIdParamsSchema, body: updateAddressBodySchema },
};
