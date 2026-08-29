const { z } = require('zod');

const {
  isValidPhone,
  normalizePhone,
} = require('./account.utils');

const objectIdSchema = (fieldName) =>
  z
    .string({ error: `${fieldName} is required` })
    .trim()
    .regex(/^[a-f\d]{24}$/i, `A valid ${fieldName.toLowerCase()} is required`);

const nameSchema = z
  .string({ error: 'Name is required' })
  .trim()
  .min(2, 'Name must contain at least 2 characters')
  .max(150, 'Name cannot exceed 150 characters')
  .transform((name) => name.replace(/\s+/g, ' '));

const emailSchema = z
  .string({ error: 'Email is required' })
  .trim()
  .min(1, 'Email is required')
  .max(254, 'Email cannot exceed 254 characters')
  .email('A valid email is required')
  .transform((email) => email.toLowerCase());

const canNormalizePhone = (value) => {
  const normalized = normalizePhone(value);
  return typeof normalized === 'string' && isValidPhone(normalized);
};

const phoneSchema = z
  .string({ error: 'Phone must be a string' })
  .trim()
  .min(1, 'Phone cannot be empty')
  .max(30, 'Phone cannot exceed 30 characters')
  .refine(
    canNormalizePhone,
    'Phone must contain 7 to 15 digits with an optional leading +',
  )
  .transform(normalizePhone);

const discountPercentSchema = z
  .number({ error: 'Discount percent must be a number' })
  .finite('Discount percent must be a finite number')
  .min(0, 'Discount percent cannot be less than 0')
  .max(100, 'Discount percent cannot exceed 100');

const managedStatusSchema = z.enum(['active', 'inactive'], {
  error: 'Status must be active or inactive',
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

const searchSchema = z
  .string({ error: 'Search must be a string' })
  .trim()
  .max(150, 'Search cannot exceed 150 characters')
  .optional();

module.exports = {
  discountPercentSchema,
  emailSchema,
  managedStatusSchema,
  nameSchema,
  objectIdSchema,
  paginationFields,
  phoneSchema,
  searchSchema,
};
