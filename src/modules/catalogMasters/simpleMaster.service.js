const ApiError = require('../../utils/ApiError');
const {
  MASTER_NAME_COLLATION,
  escapeRegex,
  normalizeName,
  validationApiError,
} = require('./master.utils');

const makeSimpleMasterService = ({ Model, singular, plural, indexPrefix, normalizeName: normalizeMasterName = normalizeName }) => {
  const duplicateError = (error) => {
    if (error?.code !== 11000) return null;
    if (error.keyPattern?.name || error.message?.includes(`unique_${indexPrefix}_name`)) {
      return new ApiError(409, `A ${singular} with this name already exists`);
    }
    return new ApiError(409, `A ${singular} with this name already exists`);
  };

  const ensureUnique = async ({ name, excludeId }) => {
    const exclusion = excludeId ? { _id: { $ne: excludeId } } : {};
    const sameName = await Model.findOne({ ...exclusion, name })
      .collation(MASTER_NAME_COLLATION)
      .select('_id')
      .lean();
    if (sameName) throw new ApiError(409, `A ${singular} with this name already exists`);
  };

  const mapError = (error) => duplicateError(error) || validationApiError(error) || error;

  const list = async ({ page, limit, search, status }) => {
    const filter = {};
    if (status) filter.status = status;
    if (search) filter.name = { $regex: escapeRegex(search), $options: 'i' };
    const skip = (page - 1) * limit;
    const [records, total] = await Promise.all([
      Model.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      Model.countDocuments(filter),
    ]);
    return {
      [plural]: records,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  };

  const getById = async (id) => {
    const record = await Model.findById(id).lean();
    if (!record) throw new ApiError(404, `${singular[0].toUpperCase()}${singular.slice(1)} not found`);
    return record;
  };

  const create = async (payload) => {
    const name = normalizeMasterName(payload.name);
    await ensureUnique({ name });
    try {
      return await Model.create({ ...payload, name });
    } catch (error) {
      throw mapError(error);
    }
  };

  const update = async (id, payload) => {
    const record = await Model.findById(id);
    if (!record) throw new ApiError(404, `${singular[0].toUpperCase()}${singular.slice(1)} not found`);
    const name = payload.name ? normalizeMasterName(payload.name) : record.name;
    await ensureUnique({ name, excludeId: id });
    Object.assign(record, payload, { name });
    try {
      return await record.save();
    } catch (error) {
      throw mapError(error);
    }
  };

  const deactivate = async (id) => {
    const record = await Model.findById(id);
    if (!record) throw new ApiError(404, `${singular[0].toUpperCase()}${singular.slice(1)} not found`);
    if (record.status !== 'inactive') {
      record.status = 'inactive';
      await record.save();
    }
    return record;
  };

  return { create, deactivate, getById, list, update };
};

module.exports = makeSimpleMasterService;
