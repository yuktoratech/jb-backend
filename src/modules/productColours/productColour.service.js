const crypto = require('crypto');
const path = require('path');
const ApiError = require('../../utils/ApiError');
const storage = require('../../storage/objectStorage.service');
const Colour = require('../colours/colour.model');
const Product = require('../products/product.model');
const ProductColour = require('./productColour.model');
const { presentProductColour } = require('./productColourImage.presenter');
const { allocateProductCode } = require('../products/catalogGeneration.service');
const { optimizeProductImage } = require('./productImageOptimization.service');

const mapError = (error) => {
  if (error instanceof ApiError) return error;
  if (error?.code === 11000) {
    if (error.keyPattern?.productCode) return new ApiError(409, 'Product Code already exists');
    return new ApiError(409, 'This Colour is already assigned to the Product');
  }
  if (error?.name === 'VersionError') return new ApiError(409, 'ProductColour changed concurrently; please retry');
  return error;
};

const populate = (query) => query.populate('product', '_id name status').populate('colour', '_id name status');

const listProductColours = async ({ page, limit, productId, colourId, status }) => {
  const filter = {};
  if (productId) filter.product = productId;
  if (colourId) filter.colour = colourId;
  if (status) filter.status = status;
  const skip = (page - 1) * limit;
  const [productColours, total] = await Promise.all([
    populate(ProductColour.find(filter)).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    ProductColour.countDocuments(filter),
  ]);
  return { productColours: await Promise.all(productColours.map(presentProductColour)), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
};

const getProductColourById = async (id) => {
  const record = await populate(ProductColour.findById(id)).lean();
  if (!record) throw new ApiError(404, 'ProductColour not found');
  return presentProductColour(record);
};

const createProductColour = async (payload) => {
  const [product, colour] = await Promise.all([
    Product.findOne({ _id: payload.productId, catalogVersion: 2, status: 'active' }).select('_id name').lean(),
    Colour.findOne({ _id: payload.colourId, status: 'active' }).select('_id name').lean(),
  ]);
  if (!product) throw new ApiError(404, 'Active finalized Product not found');
  if (!colour) throw new ApiError(404, 'Active Colour not found');
  try {
    const productCode = await allocateProductCode({ productId: product._id, colourId: colour._id, productName: product.name, colourName: colour.name });
    const record = await ProductColour.create({ product: payload.productId, colour: payload.colourId, productCode, images: [], status: payload.status || 'active' });
    return getProductColourById(record._id);
  } catch (error) { throw mapError(error); }
};

const updateProductColour = async (id, payload) => {
  const record = await ProductColour.findById(id);
  if (!record) throw new ApiError(404, 'ProductColour not found');
  if (payload.status) record.status = payload.status;
  try { await record.save(); return getProductColourById(record._id); } catch (error) { throw mapError(error); }
};

const deactivateProductColour = async (id) => updateProductColour(id, { status: 'inactive' });

const safeFilename = (value) => path.basename(String(value || 'image').split(/[/\\]/).pop()).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || 'image';
const cleanupObjects = async (objectKeys) => {
  const results = await Promise.allSettled(objectKeys.map((key) => storage.deleteObject({ key })));
  const failed = results.flatMap((result, index) => result.status === 'rejected' ? [objectKeys[index]] : []);
  if (failed.length) {
    console.error(`CRITICAL: failed to clean ${failed.length} ProductColour object(s)`);
    throw new ApiError(500, 'Image upload needs administrator review because cleanup failed');
  }
};

const uploadImages = async (id, files, { altText = '' } = {}, testHooks = {}) => {
  const record = await ProductColour.findById(id);
  if (!record) throw new ApiError(404, 'ProductColour not found');
  if (!Array.isArray(files) || !files.length) throw new ApiError(400, 'At least one product image is required');
  if (record.images.length + files.length > 50) throw new ApiError(409, 'ProductColour cannot contain more than 50 images');
  const optimized = await Promise.all(files.map(async (file) => ({
    file,
    output: await optimizeProductImage(file.buffer),
  })));
  const uploaded = [];
  let uploadingObjects = true;
  try {
    for (const { file, output } of optimized) {
      const objectKey = `product-colours/${record._id}/${crypto.randomUUID()}.webp`;
      uploaded.push({ objectKey, file, output });
      await storage.uploadObject({ key: objectKey, body: output.buffer, contentType: output.contentType });
    }
    uploadingObjects = false;
    if (process.env.NODE_ENV === 'test' && testHooks.afterObjectUpload) await testHooks.afterObjectUpload({ objectKeys: uploaded.map(({ objectKey }) => objectKey), record });
    const firstSortIndex = record.images.length;
    uploaded.forEach(({ objectKey, file, output }, index) => record.images.push({
      objectKey,
      originalFilename: safeFilename(file.originalname),
      contentType: output.contentType,
      size: output.size,
      sortIndex: firstSortIndex + index,
      altText,
    }));
    await record.save();
  } catch (error) {
    await cleanupObjects(uploaded.map(({ objectKey }) => objectKey));
    const mapped = mapError(error);
    if (mapped !== error) throw mapped;
    throw new ApiError(uploadingObjects ? 502 : 500, uploadingObjects ? 'Image storage upload failed.' : 'Unable to save image metadata.');
  }
  return getProductColourById(record._id);
};

const uploadImage = (id, file, detected, options, testHooks) => uploadImages(id, [file], options, testHooks);

const deleteImage = async (id, imageId) => {
  const record = await ProductColour.findById(id);
  if (!record) throw new ApiError(404, 'ProductColour not found');
  const image = record.images.id(imageId);
  if (!image) throw new ApiError(404, 'Image not found for this ProductColour');
  const snapshot = image.toObject();
  record.images.pull(imageId);
  record.images.sort((left, right) => left.sortIndex - right.sortIndex).forEach((entry, index) => { entry.sortIndex = index; });
  try { await record.save(); } catch (error) { throw mapError(error); }
  try { await storage.deleteObject({ key: snapshot.objectKey }); }
  catch (storageError) {
    try {
      const restore = await ProductColour.findById(id);
      restore.images.push(snapshot);
      restore.images.sort((left, right) => left.sortIndex - right.sortIndex).forEach((entry, index) => { entry.sortIndex = index; });
      await restore.save();
    } catch (restoreError) {
      console.error(`CRITICAL: object ${snapshot.objectKey} remains stored but its ProductColour metadata could not be restored`, restoreError);
      throw new ApiError(500, 'Image deletion needs administrator review');
    }
    throw new ApiError(502, 'Storage deletion failed; image metadata was restored');
  }
  return getProductColourById(id);
};

const reorderImages = async (id, imageIds) => {
  const record = await ProductColour.findById(id);
  if (!record) throw new ApiError(404, 'ProductColour not found');
  const existing = new Map(record.images.map((image) => [image._id.toString(), image]));
  if (imageIds.length !== existing.size || new Set(imageIds).size !== imageIds.length || imageIds.some((imageId) => !existing.has(imageId))) {
    throw new ApiError(400, 'Reorder must contain every existing ProductColour image ID exactly once');
  }
  record.images = imageIds.map((imageId, sortIndex) => {
    const image = existing.get(imageId);
    image.sortIndex = sortIndex;
    return image;
  });
  try { await record.save(); } catch (error) { throw mapError(error); }
  return getProductColourById(id);
};

module.exports = { createProductColour, deactivateProductColour, deleteImage, getProductColourById, listProductColours, reorderImages, updateProductColour, uploadImage, uploadImages };
