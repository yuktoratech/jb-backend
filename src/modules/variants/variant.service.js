const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const Inventory = require('../inventory/inventory.model');
const ProductColour = require('../productColours/productColour.model');
const Product = require('../products/product.model');
const SizeSet = require('../sizeSets/sizeSet.model');
const ProductVariant = require('./productVariant.model');
const { generateSku, normalizeSku, normalizeSkuPart } = require('../../utils/sku');
const { resolveOrCreateSizeSet } = require('../products/catalogGeneration.service');

const transactionUnsupported = (error) =>
  error?.code === 20 ||
  error?.originalError?.code === 20 ||
  /Transaction numbers are only allowed|does not support retryable writes/.test(error?.message || '');

const mapVariantError = (error) => {
  if (error instanceof ApiError) return error;
  if (error?.name === 'VersionError') return new ApiError(409, 'SKU changed concurrently; please retry');
  if (error?.code === 11000) {
    if (error.keyPattern?.sku || error.message?.includes('unique_variant_sku')) return new ApiError(409, 'SKU already exists');
    return new ApiError(409, 'This SizeSet is already assigned to the ProductColour');
  }
  if (error?.name === 'ValidationError') {
    return new ApiError(400, 'Validation failed', Object.values(error.errors).map((entry) => ({ field: entry.path, message: entry.message })));
  }
  return error;
};

const groupVariants = (variants) => {
  const groups = new Map();
  variants.forEach((variant) => {
    const key = variant.productColour?._id?.toString() || variant.productColour?.toString() || variant.color;
    if (!groups.has(key)) groups.set(key, variant.productColour ? { productColour: variant.productColour, skus: [] } : { color: variant.color, sizeSets: [] });
    if (variant.productColour) groups.get(key).skus.push(variant);
    else groups.get(key).sizeSets.push({ variantId: variant._id, sizeSet: variant.sizeSet, sku: variant.sku, sourceProductCode: variant.sourceProductCode, attributeOverrides: variant.attributeOverrides, status: variant.status, createdAt: variant.createdAt, updatedAt: variant.updatedAt });
  });
  return Array.from(groups.values());
};

const listProductVariants = async (productId, { status }) => {
  const product = await Product.findById(productId).select('_id name productName status catalogVersion').lean();
  if (!product) throw new ApiError(404, 'Product not found');
  const filter = { product: productId };
  if (status) filter.status = status;
  const variants = await ProductVariant.find(filter)
    .populate({ path: 'productColour', populate: { path: 'colour', select: '_id name status' } })
    .populate('sizeSetRef', '_id label sizes pieceCount status')
    .sort({ createdAt: 1, _id: 1 })
    .lean();
  return { product, variants: groupVariants(variants) };
};

const createVariant = async (productId, payload) => {
  const [product, productColour] = await Promise.all([
    Product.findOne({ _id: productId, catalogVersion: 2, status: 'active' }).populate('category', '_id sizeFamily').select('_id category').lean(),
    ProductColour.findOne({ _id: payload.productColourId, product: productId, status: 'active' }).select('_id product productCode').lean(),
  ]);
  if (!product) throw new ApiError(404, 'Active finalized Product not found');
  if (!productColour) throw new ApiError(404, 'Active ProductColour for the Product not found');
  if (!product.category?.sizeFamily) throw new ApiError(409, 'Configure a size family for this category.');
  await Promise.all([ProductVariant.init(), Inventory.init()]);
  const session = await mongoose.startSession();
  let variant;
  const write = async (transactionSession) => {
    const sizeSet = await resolveOrCreateSizeSet({ input: payload.size, sizeFamily: product.category.sizeFamily, session: transactionSession });
    const sku = generateSku(productColour.productCode, sizeSet.label);
    [variant] = await ProductVariant.create([{
      catalogVersion: 2,
      product: productId,
      productColour: productColour._id,
      sizeSetRef: sizeSet._id,
      sku,
      status: payload.status || 'active',
    }], transactionSession ? { session: transactionSession } : undefined);
    await Inventory.create([{
      variant: variant._id,
      sku: variant.sku,
      shelves: [],
      availableQuantity: 0,
      totalQuantity: 0,
      status: 'out_of_stock',
    }], transactionSession ? { session: transactionSession } : undefined);
  };
  try {
    try { await session.withTransaction(() => write(session)); }
    catch (error) {
      const unsupported = transactionUnsupported(error);
      if (!(process.env.NODE_ENV === 'test' && unsupported)) throw error;
      try { await write(null); }
      catch (fallbackError) {
        if (variant?._id) {
          await Inventory.deleteOne({ variant: variant._id });
          await ProductVariant.deleteOne({ _id: variant._id });
        }
        throw fallbackError;
      }
    }
    return await ProductVariant.findById(variant._id).populate('productColour').populate('sizeSetRef').lean();
  } catch (error) { throw mapVariantError(error); }
  finally { await session.endSession(); }
};

const updateVariant = async (variantId, payload) => {
  const variant = await ProductVariant.findById(variantId);
  if (!variant) throw new ApiError(404, 'SKU not found');
  variant.status = payload.status;
  try { return await variant.save(); } catch (error) { throw mapVariantError(error); }
};

const deactivateVariant = (variantId) => updateVariant(variantId, { status: 'inactive' });

// Legacy migration helpers remain isolated from finalized API writes.
const createVariantForMigration = async (productId, payload) => {
  try {
    return await ProductVariant.create({
      product: productId,
      color: normalizeSkuPart(payload.color, 'Color'),
      sizeSet: normalizeSkuPart(payload.sizeSet, 'Size set'),
      sku: normalizeSku(payload.sku),
      sourceProductCode: payload.sourceProductCode ? normalizeSku(payload.sourceProductCode) : undefined,
      attributeOverrides: payload.attributeOverrides,
      status: payload.status || 'active',
    });
  } catch (error) { throw mapVariantError(error); }
};

const enrichVariantForMigration = async (variantId, payload) => {
  const variant = await ProductVariant.findById(variantId);
  if (!variant) throw new ApiError(404, 'Product variant not found');
  if (payload.sourceProductCode && !variant.sourceProductCode) variant.sourceProductCode = normalizeSku(payload.sourceProductCode);
  if (payload.attributeOverrides) variant.attributeOverrides = { ...(variant.attributeOverrides?.toObject?.() || variant.attributeOverrides || {}), ...payload.attributeOverrides };
  try { return await variant.save(); } catch (error) { throw mapVariantError(error); }
};

module.exports = { createVariant, createVariantForMigration, deactivateVariant, enrichVariantForMigration, groupVariants, listProductVariants, updateVariant };
