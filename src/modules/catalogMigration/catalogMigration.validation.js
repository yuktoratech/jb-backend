const { z } = require('zod');

const catalogMigrationQuerySchema = z
  .object({
    sampleSize: z.coerce
      .number({ error: 'Sample size must be a number' })
      .int('Sample size must be an integer')
      .min(1, 'Sample size must be at least 1')
      .max(1000, 'Sample size cannot exceed 1000')
      .optional(),
  })
  .strict();

module.exports = {
  catalogMigrationQuerySchema: { query: catalogMigrationQuerySchema },
};
