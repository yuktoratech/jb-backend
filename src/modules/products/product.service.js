const mongoose = require('mongoose');
const Category = require('../categories/category.model');
const Colour = require('../colours/colour.model');
const Fabric = require('../fabrics/fabric.model');
const Fit = require('../fits/fit.model');
const Inventory = require('../inventory/inventory.model');
const inventoryService = require('../inventory/inventory.service');
const ProductColour = require('../productColours/productColour.model');
const { presentProductColour } = require('../productColours/productColourImage.presenter');
const SizeSet = require('../sizeSets/sizeSet.model');
const SubCategory = require('../subcategories/subCategory.model');
const ProductVariant = require('../variants/productVariant.model');
const { groupVariants } = require('../variants/variant.service');
const { allocateProductCode, resolveOrCreateSizeSet } = require('./catalogGeneration.service');
const Product = require('./product.model');
const ApiError = require('../../utils/ApiError');
const {
  generateSku,
  normalizeProductCode,
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

const productCategoryFields = '_id name status';
const masterFields = '_id name status';

const escapeRegex = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const transactionUnsupported = (error) =>
  error?.code === 20 ||
  error?.originalError?.code === 20 ||
  /Transaction numbers are only allowed|does not support retryable writes/.test(
    error?.message || '',
  );

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

    if (keyPattern.productCode || message.includes('unique_product_colour_code')) {
      return new ApiError(409, 'Product code already exists');
    }

    if (message.includes('unique_colour_per_product')) {
      return new ApiError(409, 'This Colour is already assigned to the Product');
    }

    if (message.includes('unique_sku_per_product_colour_size_set')) {
      return new ApiError(409, 'This SizeSet is already assigned to the ProductColour');
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
        sku: normalizeSku(`${product.productName}_${normalizedColor}_${normalizedSizeSet}`),
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
  const product = await Product.findById(productId)
    .populate('category', productCategoryFields)
    .populate('subCategory', '_id name status category')
    .populate('fitId', masterFields)
    .populate('fabricId', masterFields)
    .lean();

  if (!product) throw new ApiError(404, 'Product not found');

  if (product.catalogVersion !== 2) {
    const variants = await ProductVariant.find({ product: productId })
      .sort({ color: 1, sizeSet: 1, _id: 1 })
      .lean();
    return { product, variants: groupVariants(variants) };
  }

  const [productColours, skus] = await Promise.all([
    ProductColour.find({ product: productId })
      .populate('colour', masterFields)
      .sort({ createdAt: 1, _id: 1 })
      .lean(),
    ProductVariant.find({ product: productId })
      .populate('sizeSetRef', '_id label sizes pieceCount status')
      .sort({ createdAt: 1, _id: 1 })
      .lean(),
  ]);
  const skusByProductColour = new Map();
  skus.forEach((sku) => {
    const key = sku.productColour.toString();
    if (!skusByProductColour.has(key)) skusByProductColour.set(key, []);
    skusByProductColour.get(key).push(sku);
  });

  return {
    product,
    productColours: await Promise.all(productColours.map(async (entry) => ({
      ...await presentProductColour(entry),
      skus: skusByProductColour.get(entry._id.toString()) || [],
    }))),
  };
};

const listProducts = async ({ page, limit, search, categoryId, subCategoryId, status }) => {
  const filter = { catalogVersion: 2 };

  if (categoryId) filter.category = categoryId;
  if (subCategoryId) filter.subCategory = subCategoryId;

  if (status) {
    filter.status = status;
  }

  if (search) {
    const searchExpression = {
      $regex: escapeRegex(search),
      $options: 'i',
    };

    filter.$or = [{ name: searchExpression }, { description: searchExpression }];
  }

  const skip = (page - 1) * limit;
  const [products, total] = await Promise.all([
    Product.find(filter)
      .populate('category', productCategoryFields)
      .populate('subCategory', '_id name status category')
      .populate('fitId', masterFields)
      .populate('fabricId', masterFields)
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
  const subCategory = await SubCategory.findOne({
    _id: payload.subCategoryId,
    category: payload.categoryId,
    status: 'active',
  }).select('_id').lean();
  const [category, fit, fabric] = await Promise.all([
    Category.findOne({ _id: payload.categoryId, status: 'active' }).select('_id sizeFamily').lean(),
    Fit.findOne({ _id: payload.fitId, status: 'active' }).select('_id').lean(),
    Fabric.findOne({ _id: payload.fabricId, status: 'active' }).select('_id').lean(),
  ]);
  if (!category) throw new ApiError(404, 'Active category not found');
  if (!category.sizeFamily) throw new ApiError(409, 'Configure a size family for this category.');
  if (!subCategory) throw new ApiError(404, 'Active SubCategory for the Category not found');
  if (!fit) throw new ApiError(404, 'Active Fit not found');
  if (!fabric) throw new ApiError(404, 'Active Fabric not found');

  const colourIds = payload.productColours.map(({ colourId }) => colourId);
  const colours = await Colour.find({ _id: { $in: colourIds }, status: 'active' }).select('_id name').lean();
  if (colours.length !== new Set(colourIds).size) throw new ApiError(404, 'One or more active Colours were not found');
  const colourById = new Map(colours.map((entry) => [entry._id.toString(), entry]));

  await Promise.all([Product.init(), ProductColour.init(), ProductVariant.init(), Inventory.init()]);
  const session = await mongoose.startSession();
  let productId;
  const write = async (transactionSession) => {
    const [product] = await Product.create([{
      catalogVersion: 2,
      name: payload.name,
      description: payload.description,
      category: payload.categoryId,
      subCategory: payload.subCategoryId,
      fitId: payload.fitId,
      fabricId: payload.fabricId,
      mrpPerPieceMinor: payload.mrpPerPieceMinor,
      status: payload.status || 'active',
    }], transactionSession ? { session: transactionSession } : undefined);
    productId = product._id;
    const reservedCodes = new Set();
    const colourDocs = [];
    for (const entry of payload.productColours) {
      const colour = colourById.get(entry.colourId);
      const productCode = await allocateProductCode({ productId: product._id, colourId: colour._id, productName: product.name, colourName: colour.name, session: transactionSession, reserved: reservedCodes });
      reservedCodes.add(productCode);
      colourDocs.push({ _id: new mongoose.Types.ObjectId(), product: product._id, colour: entry.colourId, productCode, images: [], status: entry.status || 'active' });
    }
    await ProductColour.insertMany(colourDocs, transactionSession ? { session: transactionSession, ordered: true } : { ordered: true });
    const skuDocs = [];
    for (let index = 0; index < payload.productColours.length; index += 1) {
      const entry = payload.productColours[index];
      for (const skuInput of entry.skus) {
        const sizeSet = await resolveOrCreateSizeSet({ input: skuInput.size, sizeFamily: category.sizeFamily, session: transactionSession });
        skuDocs.push({
          _id: new mongoose.Types.ObjectId(),
          catalogVersion: 2,
          product: product._id,
          productColour: colourDocs[index]._id,
          sizeSetRef: sizeSet._id,
          sku: generateSku(colourDocs[index].productCode, sizeSet.label),
          status: skuInput.status || 'active',
        });
      }
    }
    const variants = await ProductVariant.insertMany(skuDocs, transactionSession ? { session: transactionSession, ordered: true } : { ordered: true });
    const now = new Date();
    await Inventory.insertMany(variants.map((variant) => ({ variant: variant._id, sku: variant.sku, shelves: [], availableQuantity: 0, totalQuantity: 0, status: 'out_of_stock', createdAt: now, updatedAt: now })), transactionSession ? { session: transactionSession, ordered: true } : { ordered: true });
  };

  try {
    try {
      await session.withTransaction(() => write(session));
    } catch (error) {
      const unsupported = transactionUnsupported(error);
      if (!(process.env.NODE_ENV === 'test' && unsupported)) throw error;
      try {
        await write(null);
      } catch (fallbackError) {
        if (productId) {
          const variantIds = await ProductVariant.find({ product: productId }).distinct('_id');
          await Inventory.deleteMany({ variant: { $in: variantIds } });
          await ProductVariant.deleteMany({ product: productId });
          await ProductColour.deleteMany({ product: productId });
          await Product.deleteOne({ _id: productId });
        }
        throw fallbackError;
      }
    }
  } catch (error) {
    throw mapCatalogError(error);
  } finally {
    await session.endSession();
  }
  return getProductById(productId);
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

  if (product.catalogVersion !== 2) {
    throw new ApiError(409, 'Legacy Product must be migrated before it can be updated through this API');
  }

  const categoryId = payload.categoryId || product.category.toString();
  const subCategoryId = payload.subCategoryId || product.subCategory.toString();
  const checks = [];
  if (payload.categoryId) checks.push(Category.exists({ _id: categoryId, status: 'active' }));
  if (payload.categoryId || payload.subCategoryId) checks.push(SubCategory.exists({ _id: subCategoryId, category: categoryId, status: 'active' }));
  if (payload.fitId) checks.push(Fit.exists({ _id: payload.fitId, status: 'active' }));
  if (payload.fabricId) checks.push(Fabric.exists({ _id: payload.fabricId, status: 'active' }));
  if ((await Promise.all(checks)).some((result) => !result)) throw new ApiError(404, 'One or more active Product masters were not found');

  if (payload.name !== undefined) product.name = payload.name;
  if (payload.description !== undefined) product.description = payload.description;
  if (payload.categoryId) product.category = payload.categoryId;
  if (payload.subCategoryId) product.subCategory = payload.subCategoryId;
  if (payload.fitId) product.fitId = payload.fitId;
  if (payload.fabricId) product.fabricId = payload.fabricId;
  if (payload.mrpPerPieceMinor !== undefined) product.mrpPerPieceMinor = payload.mrpPerPieceMinor;
  if (payload.status) product.status = payload.status;

  try {
    await product.save();
  } catch (error) {
    throw mapCatalogError(error);
  }

  if (payload.status === 'inactive') {
    await Promise.all([
      ProductVariant.updateMany(
        { product: productId },
        { $set: { status: 'inactive' }, $inc: { __v: 1 } },
      ),
      ProductColour.updateMany(
        { product: productId },
        { $set: { status: 'inactive' }, $inc: { __v: 1 } },
      ),
    ]);
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

  await ProductColour.updateMany(
    { product: productId },
    { $set: { status: 'inactive' }, $inc: { __v: 1 } },
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
