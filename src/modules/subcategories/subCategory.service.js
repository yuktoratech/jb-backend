const Category = require('../categories/category.model');
const ApiError = require('../../utils/ApiError');
const SubCategory = require('./subCategory.model');
const {
  MASTER_NAME_COLLATION,
  createSlug,
  escapeRegex,
  normalizeName,
  validationApiError,
} = require('../catalogMasters/master.utils');

const ensureActiveCategory = async (categoryId) => {
  const category = await Category.findOne({ _id: categoryId, status: 'active' }).select('_id').lean();
  if (!category) throw new ApiError(404, 'Active category not found');
};

const duplicateError = (error) => {
  if (error?.code !== 11000) return null;
  if (error.keyPattern?.name || error.message?.includes('unique_subcategory_name_per_category')) {
    return new ApiError(409, 'A SubCategory with this name already exists in the category');
  }
  return new ApiError(409, 'A SubCategory with this slug already exists in the category');
};

const ensureUnique = async ({ category, name, slug, excludeId }) => {
  const exclusion = excludeId ? { _id: { $ne: excludeId } } : {};
  const sameName = await SubCategory.findOne({ ...exclusion, category, name })
    .collation(MASTER_NAME_COLLATION)
    .select('_id')
    .lean();
  if (sameName) throw new ApiError(409, 'A SubCategory with this name already exists in the category');
  const sameSlug = await SubCategory.findOne({ ...exclusion, category, slug }).select('_id').lean();
  if (sameSlug) throw new ApiError(409, 'A SubCategory with this slug already exists in the category');
};

const mapError = (error) => duplicateError(error) || validationApiError(error) || error;

const listSubCategories = async ({ page, limit, search, status, categoryId }) => {
  const filter = {};
  if (status) filter.status = status;
  if (categoryId) filter.category = categoryId;
  if (search) filter.name = { $regex: escapeRegex(search), $options: 'i' };
  const skip = (page - 1) * limit;
  const [subCategories, total] = await Promise.all([
    SubCategory.find(filter)
      .populate('category', '_id name slug status')
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    SubCategory.countDocuments(filter),
  ]);
  return { subCategories, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
};

const getSubCategoryById = async (id) => {
  const record = await SubCategory.findById(id).populate('category', '_id name slug status').lean();
  if (!record) throw new ApiError(404, 'SubCategory not found');
  return record;
};

const createSubCategory = async (payload) => {
  await ensureActiveCategory(payload.categoryId);
  const name = normalizeName(payload.name);
  const slug = payload.slug || createSlug(name);
  if (!slug) throw new ApiError(400, 'A valid SubCategory slug could not be generated');
  await ensureUnique({ category: payload.categoryId, name, slug });
  try {
    const record = await SubCategory.create({
      category: payload.categoryId,
      name,
      slug,
      status: payload.status,
    });
    return getSubCategoryById(record._id);
  } catch (error) {
    throw mapError(error);
  }
};

const updateSubCategory = async (id, payload) => {
  const record = await SubCategory.findById(id);
  if (!record) throw new ApiError(404, 'SubCategory not found');
  if (payload.categoryId && payload.categoryId !== record.category.toString()) {
    const Product = require('../products/product.model');
    if (await Product.exists({ subCategory: record._id })) {
      throw new ApiError(409, 'Referenced SubCategory cannot be moved to another Category');
    }
  }
  const category = payload.categoryId || record.category;
  if (payload.categoryId) await ensureActiveCategory(payload.categoryId);
  const name = payload.name ? normalizeName(payload.name) : record.name;
  const slug = payload.slug || (payload.name ? createSlug(name) : record.slug);
  if (!slug) throw new ApiError(400, 'A valid SubCategory slug could not be generated');
  await ensureUnique({ category, name, slug, excludeId: id });
  record.category = category;
  record.name = name;
  record.slug = slug;
  if (payload.status) record.status = payload.status;
  try {
    await record.save();
    return getSubCategoryById(record._id);
  } catch (error) {
    throw mapError(error);
  }
};

const deactivateSubCategory = async (id) => {
  const record = await SubCategory.findById(id);
  if (!record) throw new ApiError(404, 'SubCategory not found');
  if (record.status !== 'inactive') {
    record.status = 'inactive';
    await record.save();
  }
  return getSubCategoryById(record._id);
};

module.exports = { createSubCategory, deactivateSubCategory, getSubCategoryById, listSubCategories, updateSubCategory };
