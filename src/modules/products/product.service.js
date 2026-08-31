const Category = require('../categories/category.model');
const inventoryService = require('../inventory/inventory.service');
const ProductVariant = require('../variants/productVariant.model');
const { groupVariants } = require('../variants/variant.service');
const Product = require('./product.model');
const ApiError = require('../../utils/ApiError');
const {
  generateSku,
  normalizeSku,
  normalizeSkuPart,
} = require('../../utils/sku');

const migrationProductFields = [
  'description',
  'fit',
  'patternWash',
  'fabric',
  'sleeves',
  'waist',
];

const productCategoryFields = '_id name slug status';

const escapeRegex = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getDuplicateKeyPattern = (error) =>
  error?.keyPattern ||
  error?.errorResponse?.keyPattern ||
  error?.writeErrors?.[0]?.err?.keyPattern ||
  {};

const mapCatalogError = (error) => {
  if (error instanceof ApiError) {
    return error;
  }

  if (error?.code === 11000 || error?.writeErrors?.[0]?.code === 11000) {
    const keyPattern = getDuplicateKeyPattern(error);
    const message = error.message || '';

    if (keyPattern.sku || message.includes('unique_variant_sku')) {
      return new ApiError(409, 'SKU already exists');
    }

    if (
      keyPattern.product &&
      keyPattern.color &&
      keyPattern.sizeSet
    ) {
      return new ApiError(
        409,
        'This product, color, and size set combination already exists',
      );
    }

    if (
      keyPattern.productCode ||
      message.includes('unique_product_code_when_present')
    ) {
      return new ApiError(409, 'Product code already exists');
    }

    return new ApiError(409, 'A catalog record with these values already exists');
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

const ensureActiveCategory = async (categoryId) => {
  const category = await Category.findOne({
    _id: categoryId,
    status: 'active',
  })
    .select('_id')
    .lean();

  if (!category) {
    throw new ApiError(404, 'Active category not found');
  }
};

const ensureProductCodeAvailable = async (productCode, excludeProductId) => {
  if (!productCode) {
    return;
  }

  const filter = { productCode };

  if (excludeProductId) {
    filter._id = { $ne: excludeProductId };
  }

  const existingProduct = await Product.findOne(filter).select('_id').lean();

  if (existingProduct) {
    throw new ApiError(409, 'Product code already exists');
  }
};

const ensureSkusAvailable = async (skus) => {
  const existingVariant = await ProductVariant.findOne({
    sku: { $in: skus },
  })
    .select('_id')
    .lean();

  if (existingVariant) {
    throw new ApiError(409, 'One or more SKUs already exist');
  }
};

const buildVariantRecords = (product, colors) =>
  colors.flatMap(({ color, sizeSets }) => {
    const normalizedColor = normalizeSkuPart(color, 'Color');

    return sizeSets.map((sizeSet) => {
      const normalizedSizeSet = normalizeSkuPart(sizeSet, 'Size set');

      return {
        product: product._id,
        color: normalizedColor,
        sizeSet: normalizedSizeSet,
        sku: generateSku(
          product.productName,
          normalizedColor,
          normalizedSizeSet,
        ),
        status: product.status,
      };
    });
  });

const cleanupFailedProductCreation = async (productId) => {
  try {
    const variants = await ProductVariant.find({ product: productId })
      .select('_id')
      .lean();

    await inventoryService.deleteInventoriesForVariants(
      variants.map(({ _id }) => _id),
    );
    await ProductVariant.deleteMany({ product: productId });
  } catch (error) {
    await Product.updateOne(
      { _id: productId },
      { $set: { status: 'inactive' } },
    ).catch(() => undefined);
    console.error(
      `Catalog cleanup requires review for product ${productId.toString()}`,
    );
    return false;
  }

  try {
    await Product.deleteOne({ _id: productId });
    return true;
  } catch (error) {
    await Product.updateOne(
      { _id: productId },
      { $set: { status: 'inactive' } },
    ).catch(() => undefined);
    console.error(
      `Catalog cleanup requires review for product ${productId.toString()}`,
    );
    return false;
  }
};

const persistProductWithVariants = async (product, variantRecords) => {
  let productSaved = false;

  try {
    await product.save();
    productSaved = true;
    const variants = await ProductVariant.insertMany(variantRecords, {
      ordered: true,
    });
    await inventoryService.ensureInventoriesForVariants(variants);
  } catch (error) {
    if (productSaved) {
      const cleanupSucceeded = await cleanupFailedProductCreation(product._id);

      if (!cleanupSucceeded) {
        throw new ApiError(
          500,
          'Product creation failed and cleanup could not complete safely',
        );
      }
    }

    throw mapCatalogError(error);
  }
};

const buildProductDocument = (payload) =>
  new Product({
    productName: payload.productName,
    productCode: payload.productCode,
    title: payload.title,
    category: payload.categoryId,
    description: payload.description,
    mrp: payload.mrp,
    fit: payload.fit,
    patternWash: payload.patternWash,
    fabric: payload.fabric,
    sleeves: payload.sleeves,
    waist: payload.waist,
    images: payload.images || [],
    status: payload.status || 'active',
  });

const getProductById = async (productId) => {
  const [product, variants] = await Promise.all([
    Product.findById(productId)
      .populate('category', productCategoryFields)
      .lean(),
    ProductVariant.find({ product: productId })
      .sort({ color: 1, sizeSet: 1, _id: 1 })
      .lean(),
  ]);

  if (!product) {
    throw new ApiError(404, 'Product not found');
  }

  return {
    product,
    variants: groupVariants(variants),
  };
};

const listProducts = async ({ page, limit, search, category, status }) => {
  const filter = {};

  if (category) {
    filter.category = category;
  }

  if (status) {
    filter.status = status;
  }

  if (search) {
    const searchExpression = {
      $regex: escapeRegex(search),
      $options: 'i',
    };

    filter.$or = [
      { productName: searchExpression },
      { productCode: searchExpression },
      { title: searchExpression },
    ];
  }

  const skip = (page - 1) * limit;
  const [products, total] = await Promise.all([
    Product.find(filter)
      .populate('category', productCategoryFields)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Product.countDocuments(filter),
  ]);

  return {
    products,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

const createProduct = async (payload) => {
  await ensureActiveCategory(payload.categoryId);
  await ensureProductCodeAvailable(payload.productCode);
  await Promise.all([Product.init(), ProductVariant.init()]);

  const product = buildProductDocument(payload);

  const variantRecords = buildVariantRecords(product, payload.colors);
  await ensureSkusAvailable(variantRecords.map((variant) => variant.sku));

  await persistProductWithVariants(product, variantRecords);

  return getProductById(product._id);
};

const createProductForMigration = async (payload, variants) => {
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new ApiError(400, 'At least one migration variant is required');
  }

  await ensureActiveCategory(payload.categoryId);
  await ensureProductCodeAvailable(payload.productCode);
  await Promise.all([Product.init(), ProductVariant.init()]);

  const product = buildProductDocument(payload);
  const seenSkus = new Set();
  const seenCombinations = new Set();
  const variantRecords = variants.map((variant) => {
    const color = normalizeSkuPart(variant.color, 'Color');
    const sizeSet = normalizeSkuPart(variant.sizeSet, 'Size set');
    const sku = normalizeSku(variant.sku);
    const combination = `${color}\u0000${sizeSet}`;

    if (seenSkus.has(sku)) {
      throw new ApiError(400, `Duplicate migration SKU: ${sku}`);
    }

    if (seenCombinations.has(combination)) {
      throw new ApiError(
        400,
        `Duplicate migration variant combination: ${color} / ${sizeSet}`,
      );
    }

    seenSkus.add(sku);
    seenCombinations.add(combination);

    const record = {
      product: product._id,
      color,
      sizeSet,
      sku,
      status: variant.status || product.status,
    };

    if (variant.sourceProductCode) {
      record.sourceProductCode = normalizeSku(variant.sourceProductCode);
    }

    const attributeOverrides = {};

    migrationProductFields
      .filter((field) => field !== 'description')
      .forEach((field) => {
        if (variant.attributeOverrides?.[field]) {
          attributeOverrides[field] =
            variant.attributeOverrides[field].trim();
        }
      });

    if (Object.keys(attributeOverrides).length > 0) {
      record.attributeOverrides = attributeOverrides;
    }

    return record;
  });

  await ensureSkusAvailable([...seenSkus]);
  await persistProductWithVariants(product, variantRecords);
  return getProductById(product._id);
};

const enrichProductForMigration = async (productId, payload) => {
  const product = await Product.findById(productId);

  if (!product) {
    throw new ApiError(404, 'Product not found');
  }

  if (payload.productCode) {
    const productCode = normalizeSku(payload.productCode);

    if (product.productCode && product.productCode !== productCode) {
      throw new ApiError(409, 'Existing product has a different product code');
    }

    if (!product.productCode) {
      await ensureProductCodeAvailable(productCode, productId);
      product.productCode = productCode;
    }
  }

  migrationProductFields.forEach((field) => {
    const nextValue = payload[field]?.trim();

    if (!nextValue) {
      return;
    }

    if (product[field] && product[field] !== nextValue) {
      throw new ApiError(
        409,
        `Existing product has a different ${field} value`,
      );
    }

    if (!product[field]) {
      product[field] = nextValue;
    }
  });

  if (Array.isArray(payload.images) && payload.images.length > 0) {
    product.images = [...new Set([...(product.images || []), ...payload.images])];
  }

  try {
    await product.save();
    return product;
  } catch (error) {
    throw mapCatalogError(error);
  }
};

const updateProduct = async (productId, payload) => {
  const product = await Product.findById(productId);

  if (!product) {
    throw new ApiError(404, 'Product not found');
  }

  if (payload.categoryId) {
    await ensureActiveCategory(payload.categoryId);
  }

  if (payload.productCode) {
    await ensureProductCodeAvailable(payload.productCode, productId);
  }

  const fields = [
    'productName',
    'title',
    'description',
    'mrp',
    'fit',
    'patternWash',
    'fabric',
    'sleeves',
    'waist',
    'images',
    'status',
  ];

  fields.forEach((field) => {
    if (payload[field] !== undefined) {
      product[field] = payload[field];
    }
  });

  if (payload.categoryId) {
    product.category = payload.categoryId;
  }

  if (payload.productCode !== undefined) {
    product.productCode = payload.productCode || undefined;
  }

  try {
    await product.save();
  } catch (error) {
    throw mapCatalogError(error);
  }

  if (payload.status === 'inactive') {
    await ProductVariant.updateMany(
      { product: productId },
      {
        $set: { status: 'inactive' },
        $inc: { __v: 1 },
      },
    );
  }

  return getProductById(productId);
};

const deactivateProduct = async (productId) => {
  const product = await Product.findById(productId);

  if (!product) {
    throw new ApiError(404, 'Product not found');
  }

  if (product.status !== 'inactive') {
    product.status = 'inactive';
    await product.save();
  }

  await ProductVariant.updateMany(
    { product: productId },
    {
      $set: { status: 'inactive' },
      $inc: { __v: 1 },
    },
  );

  return getProductById(productId);
};

module.exports = {
  createProduct,
  createProductForMigration,
  deactivateProduct,
  enrichProductForMigration,
  getProductById,
  listProducts,
  updateProduct,
};
