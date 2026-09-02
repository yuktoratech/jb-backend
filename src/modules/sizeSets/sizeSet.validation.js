const { z } = require('zod');

const id = z.string({ error: 'SizeSet ID is required' }).trim().regex(/^[a-f\d]{24}$/i, 'A valid SizeSet ID is required');
const label = z.string({ error: 'SizeSet label is required' }).trim().min(1, 'SizeSet label is required').max(100, 'SizeSet label cannot exceed 100 characters').transform((value) => value.replace(/\s+/g, ' '));
const size = z.string({ error: 'Each size must be a string' }).trim().min(1, 'SizeSet sizes cannot be empty').max(50, 'A size cannot exceed 50 characters').transform((value) => value.replace(/\s+/g, ' '));
const sizes = z
  .array(size, { error: 'SizeSet sizes are required' })
  .min(1, 'SizeSet must contain at least one size')
  .max(100, 'SizeSet cannot contain more than 100 sizes')
  .superRefine((values, context) => {
    const seen = new Set();
    values.forEach((value, index) => {
      const key = value.toLocaleLowerCase('en');
      if (seen.has(key)) context.addIssue({ code: 'custom', path: [index], message: 'SizeSet sizes cannot contain duplicates' });
      seen.add(key);
    });
  });
const status = z.enum(['active', 'inactive'], { error: 'Status must be active or inactive' });
const params = z.object({ id }).strict();

module.exports = {
  createSizeSetSchema: { body: z.object({ label, sizes, status: status.optional() }).strict() },
  listSizeSetsSchema: {
    query: z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20), search: z.string().trim().max(100).optional(), status: status.optional() }).strict(),
  },
  sizeSetIdSchema: { params },
  updateSizeSetSchema: {
    params,
    body: z.object({ label: label.optional(), sizes: sizes.optional(), status: status.optional() }).strict().refine((body) => Object.keys(body).length > 0, { message: 'At least one field is required' }),
  },
};
