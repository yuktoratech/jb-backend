const { z } = require('zod');
const batchId = z.object({ batchId: z.string().trim().regex(/^[a-f\d]{24}$/i, 'A valid Product Import batch ID is required') }).strict();
module.exports = { applyProductImportSchema: { params: batchId } };
