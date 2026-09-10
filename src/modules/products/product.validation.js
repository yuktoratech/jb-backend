const { z } = require('zod');
const { normalizeProductName } = require('../../utils/sku');

const objectId = (label) => z.string({ error: `${label} is required` }).trim().regex(/^[a-f\d]{24}$/i, `A valid ${label.toLowerCase()} is required`);
const requiredText = (label, max) => z.string({ error: `${label} is required` }).trim().min(1, `${label} is required`).max(max, `${label} cannot exceed ${max} characters`).transform((value) => value.replace(/\s+/g, ' '));
const productName = z.string({ error: 'Product name is required' }).min(1, 'Product name is required').max(150, 'Product name cannot exceed 150 characters').transform((value, context) => { try { return normalizeProductName(value); } catch (error) { context.addIssue({ code: 'custom', message: error.message }); return z.NEVER; } });
const optionalText = (label, max) => z.string({ error: `${label} must be a string` }).trim().max(max, `${label} cannot exceed ${max} characters`).optional();
const status = z.enum(['active', 'inactive'], { error: 'Status must be active or inactive' });
const sizeInput = requiredText('Size', 100);
const skuInput = z.object({ size: sizeInput, status: status.optional() }).strict();
const productColourInput = z
  .object({
    colourId: objectId('Colour ID'),
    status: status.optional(),
    skus: z.array(skuInput).min(1, 'At least one SKU is required').max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set();
    value.skus.forEach((sku, index) => {
      const key = sku.size.toUpperCase().replace(/\s+/g, '');
      if (ids.has(key)) context.addIssue({ code: 'custom', path: ['skus', index, 'size'], message: 'Duplicate Size Sets are not allowed for one ProductColour' });
      ids.add(key);
    });
  });
const productIdParams = z.object({ id: objectId('Product ID') }).strict();
const variantIdParams = z.object({ id: objectId('SKU ID') }).strict();

const createProductBody = z
  .object({
    name: productName,
    description: optionalText('Description', 5000),
    categoryId: objectId('Category ID'),
    subCategoryId: objectId('SubCategory ID'),
    fitId: objectId('Fit ID'),
    fabricId: objectId('Fabric ID'),
    mrpPerPieceMinor: z.number({ error: 'MRP per piece is required' }).int('MRP per piece must be a whole number').positive('MRP must be greater than zero.').max(Number.MAX_SAFE_INTEGER),
    status: status.optional(),
    productColours: z.array(productColourInput).min(1, 'At least one ProductColour is required').max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const colours = new Set();
    value.productColours.forEach((entry, colourIndex) => {
      if (colours.has(entry.colourId)) context.addIssue({ code: 'custom', path: ['productColours', colourIndex, 'colourId'], message: 'Duplicate Colours are not allowed' });
      colours.add(entry.colourId);
    });
  });

const updateProductBody = z.object({
  name: productName.optional(),
  description: z.string().trim().max(5000).optional(),
  categoryId: objectId('Category ID').optional(),
  subCategoryId: objectId('SubCategory ID').optional(),
  fitId: objectId('Fit ID').optional(),
  fabricId: objectId('Fabric ID').optional(),
  mrpPerPieceMinor: z.number().int().positive('MRP must be greater than zero.').max(Number.MAX_SAFE_INTEGER).optional(),
  status: status.optional(),
}).strict().refine((body) => Object.keys(body).length > 0, { message: 'At least one field is required' });

const pagination = { page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) };
const createSkuBody = z.object({ productColourId: objectId('ProductColour ID'), size: sizeInput, status: status.optional() }).strict();

module.exports = {
  createProductSchema: { body: createProductBody },
  createVariantSchema: { params: productIdParams, body: createSkuBody },
  listProductsSchema: { query: z.object({ ...pagination, search: z.string().trim().max(150).optional(), categoryId: objectId('Category ID').optional(), subCategoryId: objectId('SubCategory ID').optional(), status: status.optional() }).strict() },
  listVariantsSchema: { params: productIdParams, query: z.object({ status: status.optional() }).strict() },
  productIdSchema: { params: productIdParams },
  updateProductSchema: { params: productIdParams, body: updateProductBody },
  updateVariantSchema: { params: variantIdParams, body: z.object({ status }).strict() },
  variantIdSchema: { params: variantIdParams },
  productColourInput,
  productNameSchema: productName,
  skuInput,
  statusSchema: status,
};
