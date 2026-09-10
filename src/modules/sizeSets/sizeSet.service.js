const ApiError = require('../../utils/ApiError');
const SizeSet = require('./sizeSet.model');
const { canonicalizeSizeSet, inferSizeFamily, sameCanonicalSizes } = require('./sizeSetCanonical');
const { MASTER_NAME_COLLATION, escapeRegex, validationApiError } = require('../catalogMasters/master.utils');

const duplicateError = (error) =>
  error?.code === 11000 ? new ApiError(409, 'A SizeSet with this label already exists') : null;

const ensureUniqueLabel = async (label, excludeId) => {
  const filter = { label, ...(excludeId ? { _id: { $ne: excludeId } } : {}) };
  const existing = await SizeSet.findOne(filter).collation(MASTER_NAME_COLLATION).select('_id').lean();
  if (existing) throw new ApiError(409, 'A SizeSet with this label already exists');
};

const mapError = (error) => duplicateError(error) || validationApiError(error) || error;

const listSizeSets = async ({ page, limit, search, status }) => {
  const filter = {};
  if (status) filter.status = status;
  if (search) filter.label = { $regex: escapeRegex(search), $options: 'i' };
  const skip = (page - 1) * limit;
  const [sizeSets, total] = await Promise.all([
    SizeSet.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    SizeSet.countDocuments(filter),
  ]);
  return { sizeSets, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
};

const getSizeSetById = async (id) => {
  const record = await SizeSet.findById(id).lean();
  if (!record) throw new ApiError(404, 'SizeSet not found');
  return record;
};

const createSizeSet = async (payload) => {
  const canonical = canonicalizeSizeSet(payload.label, inferSizeFamily(payload.label));
  await ensureUniqueLabel(canonical.label);
  try {
    return await SizeSet.create({ ...canonical, status: payload.status });
  } catch (error) {
    throw mapError(error);
  }
};

const updateSizeSet = async (id, payload) => {
  const record = await SizeSet.findById(id);
  if (!record) throw new ApiError(404, 'SizeSet not found');
  let canonical;
  if (payload.label !== undefined) {
    canonical = canonicalizeSizeSet(payload.label, inferSizeFamily(payload.label));
  }
  const identityChanges = canonical && (
    canonical.label !== record.label || !sameCanonicalSizes(canonical.sizes, record.sizes)
  );
  if (identityChanges) {
    const ProductVariant = require('../variants/productVariant.model');
    const isReferenced = await ProductVariant.exists({ sizeSetRef: record._id });
    if (isReferenced) {
      throw new ApiError(409, 'Referenced SizeSet label and sizes are immutable; only status may change');
    }
  }
  const nextLabel = canonical?.label || record.label;
  await ensureUniqueLabel(nextLabel, id);
  if (canonical) {
    record.label = canonical.label;
    record.sizes = canonical.sizes;
  }
  if (payload.status) record.status = payload.status;
  try {
    return await record.save();
  } catch (error) {
    throw mapError(error);
  }
};

const deactivateSizeSet = async (id) => {
  const record = await SizeSet.findById(id);
  if (!record) throw new ApiError(404, 'SizeSet not found');
  if (record.status !== 'inactive') {
    record.status = 'inactive';
    await record.save();
  }
  return record;
};

module.exports = { createSizeSet, deactivateSizeSet, getSizeSetById, listSizeSets, updateSizeSet };
