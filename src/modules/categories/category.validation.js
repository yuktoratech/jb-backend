const { z } = require('zod');

const CATEGORY_STATUSES = ['active', 'inactive'];

const objectIdSchema = z
  .string({ error: 'Category ID is required' })
  .trim()
  .regex(/^[a-f\d]{24}$/i, 'A valid category ID is required');

const nameSchema = z
  .string({ error: 'Category name is required' })
  .trim()
  .min(1, 'Category name is required')
  .max(100, 'Category name cannot exceed 100 characters');

const descriptionSchema = z
  .string({ error: 'Description must be a string' })
  .trim()
  .max(1000, 'Description cannot exceed 1000 characters');

const statusSchema = z.enum(CATEGORY_STATUSES, {
  error: 'Status must be active or inactive',
});
const sizeFamilySchema = z.enum(['ALPHA', 'NUMERIC'], { error: 'Size family must be ALPHA or NUMERIC' });

const categoryIdParamsSchema = z
  .object({
    id: objectIdSchema,
  })
  .strict();

const createCategoryBodySchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema.optional(),
    sizeFamily: sizeFamilySchema,
    status: statusSchema.optional(),
  })
  .strict();

const updateCategoryBodySchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    sizeFamily: sizeFamilySchema.optional(),
    status: statusSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'At least one field is required',
  });

const listCategoriesQuerySchema = z
  .object({
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
    search: z
      .string({ error: 'Search must be a string' })
      .trim()
      .max(100, 'Search cannot exceed 100 characters')
      .optional(),
    status: statusSchema.optional(),
  })
  .strict();

const createCategorySchema = {
  body: createCategoryBodySchema,
};

const updateCategorySchema = {
  params: categoryIdParamsSchema,
  body: updateCategoryBodySchema,
};

const categoryIdSchema = {
  params: categoryIdParamsSchema,
};

const listCategoriesSchema = {
  query: listCategoriesQuerySchema,
};

module.exports = {
  categoryIdSchema,
  createCategorySchema,
  listCategoriesSchema,
  updateCategorySchema,
};
