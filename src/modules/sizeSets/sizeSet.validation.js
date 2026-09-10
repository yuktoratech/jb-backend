const { z } = require('zod');

const id = z.string({ error: 'SizeSet ID is required' }).trim().regex(/^[a-f\d]{24}$/i, 'A valid SizeSet ID is required');
const label = z.string({ error: 'SizeSet label is required' }).trim().min(1, 'SizeSet label is required').max(100, 'SizeSet label cannot exceed 100 characters').transform((value) => value.replace(/\s+/g, ' '));
const status = z.enum(['active', 'inactive'], { error: 'Status must be active or inactive' });
const params = z.object({ id }).strict();

module.exports = {
  createSizeSetSchema: { body: z.object({ label, status: status.optional() }).strict() },
  listSizeSetsSchema: {
    query: z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20), search: z.string().trim().max(100).optional(), status: status.optional() }).strict(),
  },
  sizeSetIdSchema: { params },
  updateSizeSetSchema: {
    params,
    body: z.object({ label: label.optional(), status: status.optional() }).strict().refine((body) => Object.keys(body).length > 0, { message: 'At least one field is required' }),
  },
};
