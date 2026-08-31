const Product = require('../products/product.model');
const inventoryService = require('../inventory/inventory.service');
const ProductVariant = require('./productVariant.model');
const ApiError = require('../../utils/ApiError');
const {
  generateSku,
  normalizeSku,
  normalizeSkuPart,
} = require('../../utils/sku');

const migrationAttributeFields = [
  'fit',
  'patternWash',
  'fabric',
  'sleeves',
  'waist',
];

const mapVariantError = (error) => {
  if (error instanceof ApiError) {
    return error;
  }

  if (error?.name === 'VersionError') {
    return new ApiError(409, 'Product variant changed concurrently; please retry');
  }

  if (error?.code === 11000) {
    const keyPattern = error.keyPattern || error.errorResponse?.keyPattern || {};

    if (keyPattern.sku || error.message?.includes('unique_variant_sku')) {
      return new ApiError(409, 'SKU already exists');
    }

    return new ApiError(
      409,
      'This product, color, and size set combination already exists',
    );
  }

  if (error?.name === 'ValidationError') {
    return new ApiError(
      400,
      'Validation failed',
      Object.values(error.errors).map((validationError) => ({
        field: validationError.path,
        message: validationError.message,
      })),
    );
  }

  return error;
};

const groupVariants = (variants) => {
  const groupedByColor = new Map();

  variants.forEach((variant) => {
    if (!groupedByColor.has(variant.color)) {
      groupedByColor.set(variant.color, {
        color: variant.color,
        sizeSets: [],
      });
    }

    groupedByColor.get(variant.color).sizeSets.push({
      variantId: variant._id,
      sizeSet: variant.sizeSet,
      sku: variant.sku,
      sourceProductCode: variant.sourceProductCode,
      attributeOverrides: variant.attributeOverrides,
      status: variant.status,
      createdAt: variant.createdAt,
      updatedAt: variant.updatedAt,
    });
  });

  return Array.from(groupedByColor.values());
};

const ensureVariantAvailable = async ({
  productId,
  color,
  sizeSet,
  sku,
  excludeVariantId,
}) => {
  const filter = {
    $or: [
      { sku },
      {
        product: productId,
        color,
        sizeSet,
      },
    ],
  };

  if (excludeVariantId) {
    filter._id = { $ne: excludeVariantId };
  }

  const conflict = await ProductVariant.findOne(filter)
    .select('sku color sizeSet')
    .lean();

  if (!conflict) {
    return;
  }

  if (conflict.sku === sku) {
    throw new ApiError(409, 'SKU already exists');
  }

  throw new ApiError(
    409,
    'This product, color, and size set combination already exists',
  );
};

const listProductVariants = async (productId, { status }) => {
  const product = await Product.findById(productId)
    .select('_id productName productCode title status')
    .lean();

  if (!product) {
    throw new ApiError(404, 'Product not found');
  }

  const filter = { product: productId };

  if (status) {
    filter.status = status;
  }

  const variants = await ProductVariant.find(filter)
    .sort({ color: 1, sizeSet: 1, _id: 1 })
    .lean();

  return {
    product,
    variants: groupVariants(variants),
  };
};

const createVariantInternal = async (
  productId,
  payload,
  { includeMigrationMetadata = false } = {},
) => {
  const product = await Product.findById(productId)
    .select('_id productName status')
    .lean();

  if (!product) {
    throw new ApiError(404, 'Product not found');
  }

  if (product.status !== 'active') {
    throw new ApiError(409, 'Variants cannot be added to an inactive product');
  }

  const color = normalizeSkuPart(payload.color, 'Color');
  const sizeSet = normalizeSkuPart(payload.sizeSet, 'Size set');
  const sku = payload.sku
    ? normalizeSku(payload.sku)
    : generateSku(product.productName, color, sizeSet);

  await ProductVariant.init();
  await ensureVariantAvailable({ productId, color, sizeSet, sku });

  let variant;

  try {
    const variantPayload = {
      product: productId,
      color,
      sizeSet,
      sku,
      status: payload.status || 'active',
    };

    if (includeMigrationMetadata) {
      if (payload.sourceProductCode) {
        variantPayload.sourceProductCode = normalizeSku(
          payload.sourceProductCode,
        );
      }

      const attributeOverrides = {};

      migrationAttributeFields.forEach((field) => {
        if (payload.attributeOverrides?.[field]) {
          attributeOverrides[field] = payload.attributeOverrides[field].trim();
        }
      });

      if (Object.keys(attributeOverrides).length > 0) {
        variantPayload.attributeOverrides = attributeOverrides;
      }
    }

    variant = await ProductVariant.create(variantPayload);
    await inventoryService.ensureInventoryForVariant(variant);
    return variant;
  } catch (error) {
    if (variant) {
      try {
        await inventoryService.deleteInventoriesForVariants([variant._id]);
        await ProductVariant.deleteOne({ _id: variant._id });
      } catch (cleanupError) {
        await ProductVariant.updateOne(
          { _id: variant._id },
          { $set: { status: 'inactive' } },
        ).catch(() => undefined);
        console.error(
          `Variant creation cleanup requires review for ${variant._id.toString()}`,
        );
        throw new ApiError(
          500,
          'Variant creation failed and cleanup could not complete safely',
        );
      }
    }

    throw mapVariantError(error);
  }
};

const createVariant = (productId, payload) =>
  createVariantInternal(productId, payload);

const createVariantForMigration = (productId, payload) =>
  createVariantInternal(productId, payload, {
    includeMigrationMetadata: true,
  });

const enrichVariantForMigration = async (variantId, payload) => {
  const variant = await ProductVariant.findById(variantId);

  if (!variant) {
    throw new ApiError(404, 'Product variant not found');
  }

  if (payload.sourceProductCode) {
    const sourceProductCode = normalizeSku(payload.sourceProductCode);

    if (
      variant.sourceProductCode &&
      variant.sourceProductCode !== sourceProductCode
    ) {
      throw new ApiError(
        409,
        'Existing variant has a different source product code',
      );
    }

    if (!variant.sourceProductCode) {
      variant.sourceProductCode = sourceProductCode;
    }
  }

  migrationAttributeFields.forEach((field) => {
    const nextValue = payload.attributeOverrides?.[field]?.trim();

    if (!nextValue) {
      return;
    }

    const currentValue = variant.attributeOverrides?.[field];

    if (currentValue && currentValue !== nextValue) {
      throw new ApiError(
        409,
        `Existing variant has a different ${field} override`,
      );
    }

    if (!currentValue) {
      variant.set(`attributeOverrides.${field}`, nextValue);
    }
  });

  try {
    await variant.save();
    return variant;
  } catch (error) {
    throw mapVariantError(error);
  }
};

const updateVariant = async (variantId, payload) => {
  const variant = await ProductVariant.findById(variantId);

  if (!variant) {
    throw new ApiError(404, 'Product variant not found');
  }

  const product = await Product.findById(variant.product)
    .select('_id productName')
    .lean();

  if (!product) {
    throw new ApiError(404, 'Parent product not found');
  }

  const color = payload.color
    ? normalizeSkuPart(payload.color, 'Color')
    : variant.color;
  const sizeSet = payload.sizeSet
    ? normalizeSkuPart(payload.sizeSet, 'Size set')
    : variant.sizeSet;

  let sku = variant.sku;

  if (payload.sku) {
    sku = normalizeSku(payload.sku);
  } else if (payload.color || payload.sizeSet) {
    sku = generateSku(product.productName, color, sizeSet);
  }

  await ensureVariantAvailable({
    productId: variant.product,
    color,
    sizeSet,
    sku,
    excludeVariantId: variantId,
  });

  const originalValues = {
    color: variant.get('color', null, { getters: false }),
    sizeSet: variant.get('sizeSet', null, { getters: false }),
    sku: variant.get('sku', null, { getters: false }),
    status: variant.get('status', null, { getters: false }),
  };

  variant.color = color;
  variant.sizeSet = sizeSet;
  variant.sku = sku;

  if (payload.status) {
    variant.status = payload.status;
  }

  let variantSaved = false;

  try {
    await variant.save();
    variantSaved = true;
    await inventoryService.syncInventorySku(variant);
    return variant;
  } catch (error) {
    if (variantSaved) {
      try {
        variant.set(originalValues);
        await variant.save();
        await inventoryService.syncInventorySku(variant);
      } catch (rollbackError) {
        console.error(
          `Variant update rollback requires review for ${variant._id.toString()}`,
        );
        throw new ApiError(
          500,
          'Variant update failed and rollback could not complete safely',
        );
      }
    }

    throw mapVariantError(error);
  }
};

const deactivateVariant = async (variantId) => {
  const variant = await ProductVariant.findById(variantId);

  if (!variant) {
    throw new ApiError(404, 'Product variant not found');
  }

  if (variant.status !== 'inactive') {
    variant.status = 'inactive';

    try {
      await variant.save();
    } catch (error) {
      throw mapVariantError(error);
    }
  }

  return variant;
};

module.exports = {
  createVariant,
  createVariantForMigration,
  deactivateVariant,
  enrichVariantForMigration,
  groupVariants,
  listProductVariants,
  updateVariant,
};
