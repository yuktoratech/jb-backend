const { z } = require('zod');
const base = require('../catalogMasters/simpleMaster.validation')('Colour');

const upperName = z.string().trim().min(1, 'Colour name is required').max(100).transform((value) => value.replace(/\s+/g, ' ').toUpperCase());
base.createSchema.body = base.createSchema.body.safeExtend({ name: upperName }).strict();
base.updateSchema.body = base.updateSchema.body.safeExtend({ name: upperName.optional() }).strict();
module.exports = base;
