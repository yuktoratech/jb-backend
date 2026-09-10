const { z } = require('zod');

const MASTER_STATUSES = ['active', 'inactive'];

const makeSimpleMasterValidation = (label) => {
  const lowerLabel = label.toLowerCase();
  const idSchema = z
    .string({ error: `${label} ID is required` })
    .trim()
    .regex(/^[a-f\d]{24}$/i, `A valid ${lowerLabel} ID is required`);
  const nameSchema = z
    .string({ error: `${label} name is required` })
    .trim()
    .min(1, `${label} name is required`)
    .max(100, `${label} name cannot exceed 100 characters`);
  const statusSchema = z.enum(MASTER_STATUSES, {
    error: 'Status must be active or inactive',
  });
  const idParams = z.object({ id: idSchema }).strict();
  const createBody = z
    .object({
      name: nameSchema,
      status: statusSchema.optional(),
    })
    .strict();
  const updateBody = z
    .object({
      name: nameSchema.optional(),
      status: statusSchema.optional(),
    })
    .strict()
    .refine((body) => Object.keys(body).length > 0, {
      message: 'At least one field is required',
    });
  const listQuery = z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      search: z.string().trim().max(100).optional(),
      status: statusSchema.optional(),
    })
    .strict();

  return {
    createSchema: { body: createBody },
    idSchema: { params: idParams },
    listSchema: { query: listQuery },
    updateSchema: { params: idParams, body: updateBody },
  };
};

module.exports = makeSimpleMasterValidation;
