const { z } = require('zod');

const objectId = (label) =>
  z.string({ error: `${label} is required` }).trim().regex(/^[a-f\d]{24}$/i, `A valid ${label.toLowerCase()} is required`);
const name = z.string({ error: 'SubCategory name is required' }).trim().min(1).max(100);
const status = z.enum(['active', 'inactive'], { error: 'Status must be active or inactive' });
const params = z.object({ id: objectId('SubCategory ID') }).strict();

module.exports = {
  createSubCategorySchema: {
    body: z.object({ categoryId: objectId('Category ID'), name, status: status.optional() }).strict(),
  },
  listSubCategoriesSchema: {
    query: z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        search: z.string().trim().max(100).optional(),
        status: status.optional(),
        categoryId: objectId('Category ID').optional(),
      })
      .strict(),
  },
  subCategoryIdSchema: { params },
  updateSubCategorySchema: {
    params,
    body: z
      .object({ categoryId: objectId('Category ID').optional(), name: name.optional(), status: status.optional() })
      .strict()
      .refine((body) => Object.keys(body).length > 0, { message: 'At least one field is required' }),
  },
};
