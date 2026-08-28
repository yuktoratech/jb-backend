const { z } = require('zod');

const { normalizeSku, normalizeSkuPart } = require('../../utils/sku');

const objectIdSchema = (fieldName) =>
  z
    .string({ error: `${fieldName} is required` })
    .trim()
    .regex(/^[a-f\d]{24}$/i, `A valid ${fieldName.toLowerCase()} is required`);

const requiredString = (fieldName, maxLength) =>
  z
    .string({ error: `${fieldName} is required` })
    .trim()
    .min(1, `${fieldName} is required`)
    .max(maxLength, `${fieldName} cannot exceed ${maxLength} characters`);

const optionalString = (fieldName, maxLength) =>
  z
    .string({ error: `${fieldName} must be a string` })
    .trim()
    .max(maxLength, `${fieldName} cannot exceed ${maxLength} characters`)
    .optional();

const canNormalizeSkuPart = (value) => {
  try {
    normalizeSkuPart(value);
    return true;
  } catch (error) {
    return false;
  }
};

const canNormalizeSku = (value) => {
  try {
    normalizeSku(value);
    return true;
  } catch (error) {
    return false;
  }
};

const productNameSchema = requiredString('Product name', 150).refine(
  canNormalizeSkuPart,
  'Product name must contain letters or numbers that can be used in a SKU',
);

const productCodeSchema = requiredString('Product code', 100)
  .regex(
    /^[a-zA-Z0-9]+(?:[-_][a-zA-Z0-9]+)*$/,
    'Product code may contain only letters, numbers, single hyphens, and underscores',
  )
  .transform((value) => value.toUpperCase());

const titleSchema = requiredString('Product title', 300);
const categoryIdSchema = objectIdSchema('Category ID');
const productIdSchema = objectIdSchema('Product ID');
const variantIdSchema = objectIdSchema('Variant ID');

const mrpSchema = z
  .number({ error: 'MRP must be a number' })
  .finite('MRP must be a finite number')
  .nonnegative('MRP cannot be negative');

const statusSchema = z.enum(['active', 'inactive'], {
  error: 'Status must be active or inactive',
});

const imageSchema = z
  .string({ error: 'Each image must be a string' })
  .trim()
  .min(1, 'Image values cannot be empty')
  .max(2048, 'Image values cannot exceed 2048 characters');

const colorSchema = requiredString('Color', 100).refine(
  canNormalizeSkuPart,
  'Color must contain letters or numbers that can be used in a SKU',
);

const sizeSetSchema = requiredString('Size set', 100).refine(
  canNormalizeSkuPart,
  'Size set must contain letters or numbers that can be used in a SKU',
);

const skuSchema = requiredString('SKU', 255).refine(
  canNormalizeSku,
  'SKU must contain letters or numbers',
);

const colorGroupSchema = z
  .object({
    color: colorSchema,
    sizeSets: z
      .array(sizeSetSchema, { error: 'Size sets must be an array' })
      .min(1, 'At least one size set is required')
      .max(100, 'A color cannot contain more than 100 size sets'),
  })
  .strict();

const colorsSchema = z
  .array(colorGroupSchema, { error: 'Colors must be an array' })
  .min(1, 'At least one color is required')
  .max(100, 'A product cannot contain more than 100 colors')
  .superRefine((colors, context) => {
    const seenColors = new Set();

    colors.forEach((colorGroup, colorIndex) => {
      let normalizedColor;

      try {
        normalizedColor = normalizeSkuPart(colorGroup.color, 'Color');
      } catch (error) {
        return;
      }

      if (seenColors.has(normalizedColor)) {
        context.addIssue({
          code: 'custom',
          path: [colorIndex, 'color'],
          message: 'Duplicate colors are not allowed',
        });
      }

      seenColors.add(normalizedColor);

      const seenSizeSets = new Set();

      colorGroup.sizeSets.forEach((sizeSet, sizeSetIndex) => {
        let normalizedSizeSet;

        try {
          normalizedSizeSet = normalizeSkuPart(sizeSet, 'Size set');
        } catch (error) {
          return;
        }

        if (seenSizeSets.has(normalizedSizeSet)) {
          context.addIssue({
            code: 'custom',
            path: [colorIndex, 'sizeSets', sizeSetIndex],
            message: 'Duplicate size sets are not allowed for the same color',
          });
        }

        seenSizeSets.add(normalizedSizeSet);
      });
    });
  });

const productFields = {
  productName: productNameSchema,
  productCode: productCodeSchema.optional(),
  title: titleSchema,
  categoryId: categoryIdSchema,
  description: optionalString('Description', 5000),
  mrp: mrpSchema,
  fit: optionalString('Fit', 200),
  patternWash: optionalString('Pattern/wash', 200),
  fabric: optionalString('Fabric', 200),
  sleeves: optionalString('Sleeves', 200),
  waist: optionalString('Waist', 100),
  images: z
    .array(imageSchema, { error: 'Images must be an array' })
    .max(50, 'A product cannot contain more than 50 images')
    .optional(),
  status: statusSchema.optional(),
};

const createProductBodySchema = z
  .object({
    ...productFields,
    colors: colorsSchema,
  })
  .strict();

const updateProductBodySchema = z
  .object({
    productName: productNameSchema.optional(),
    productCode: productCodeSchema.nullable().optional(),
    title: titleSchema.optional(),
    categoryId: categoryIdSchema.optional(),
    description: optionalString('Description', 5000),
    mrp: mrpSchema.optional(),
    fit: optionalString('Fit', 200),
    patternWash: optionalString('Pattern/wash', 200),
    fabric: optionalString('Fabric', 200),
    sleeves: optionalString('Sleeves', 200),
    waist: optionalString('Waist', 100),
    images: z
      .array(imageSchema, { error: 'Images must be an array' })
      .max(50, 'A product cannot contain more than 50 images')
      .optional(),
    status: statusSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'At least one field is required',
  });

const paginationFields = {
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
};

const listProductsQuerySchema = z
  .object({
    ...paginationFields,
    search: z
      .string({ error: 'Search must be a string' })
      .trim()
      .max(150, 'Search cannot exceed 150 characters')
      .optional(),
    category: categoryIdSchema.optional(),
    status: statusSchema.optional(),
  })
  .strict();

const createVariantBodySchema = z
  .object({
    color: colorSchema,
    sizeSet: sizeSetSchema,
    sku: skuSchema.optional(),
    status: statusSchema.optional(),
  })
  .strict();

const updateVariantBodySchema = z
  .object({
    color: colorSchema.optional(),
    sizeSet: sizeSetSchema.optional(),
    sku: skuSchema.optional(),
    status: statusSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'At least one field is required',
  });

const listVariantsQuerySchema = z
  .object({
    status: statusSchema.optional(),
  })
  .strict();

const productIdParamsSchema = z.object({ id: productIdSchema }).strict();
const variantIdParamsSchema = z.object({ id: variantIdSchema }).strict();

module.exports = {
  createProductSchema: { body: createProductBodySchema },
  createVariantSchema: {
    params: productIdParamsSchema,
    body: createVariantBodySchema,
  },
  listProductsSchema: { query: listProductsQuerySchema },
  listVariantsSchema: {
    params: productIdParamsSchema,
    query: listVariantsQuerySchema,
  },
  productIdSchema: { params: productIdParamsSchema },
  updateProductSchema: {
    params: productIdParamsSchema,
    body: updateProductBodySchema,
  },
  updateVariantSchema: {
    params: variantIdParamsSchema,
    body: updateVariantBodySchema,
  },
  variantIdSchema: { params: variantIdParamsSchema },
};
