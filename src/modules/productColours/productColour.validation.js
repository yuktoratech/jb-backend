const { z } = require('zod');

const id = (label) => z.string({ error: `${label} is required` }).trim().regex(/^[a-f\d]{24}$/i, `A valid ${label.toLowerCase()} is required`);
const status = z.enum(['active', 'inactive'], { error: 'Status must be active or inactive' });
const params = z.object({ id: id('ProductColour ID') }).strict();
const imageParams = z.object({ id: id('ProductColour ID'), imageId: id('Image ID') }).strict();

module.exports = {
  createProductColourSchema: { body: z.object({ productId: id('Product ID'), colourId: id('Colour ID'), status: status.optional() }).strict() },
  deleteImageSchema: { params: imageParams },
  listProductColoursSchema: { query: z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20), productId: id('Product ID').optional(), colourId: id('Colour ID').optional(), status: status.optional() }).strict() },
  productColourIdSchema: { params },
  reorderImagesSchema: { params, body: z.object({ imageIds: z.array(id('Image ID')).max(50) }).strict() },
  updateProductColourSchema: { params, body: z.object({ status: status.optional() }).strict().refine((body) => Object.keys(body).length > 0, { message: 'At least one field is required' }) },
  uploadImageSchema: { params, body: z.object({ altText: z.string().trim().max(300).optional().default('') }).strict() },
};
