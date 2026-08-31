const Category = require('./category.model');
const ApiError = require('../../utils/ApiError');

const CATEGORY_NAME_COLLATION = { locale: 'en', strength: 2 };

const normalizeName = (name) => name.trim().replace(/\s+/g, ' ');

const createSlug = (value) =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const escapeRegex = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const duplicateCategoryError = (error) => {
  if (error?.code !== 11000) {
    return null;
  }

  if (error.keyPattern?.name || error.message?.includes('unique_category_name')) {
    return new ApiError(409, 'A category with this name already exists');
  }

  return new ApiError(409, 'A category with this slug already exists');
};

const ensureUniqueCategory = async ({ name, slug, excludeId }) => {
  const exclusion = excludeId ? { _id: { $ne: excludeId } } : {};

  const categoryWithName = await Category.findOne({
    ...exclusion,
    name,
  })
    .collation(CATEGORY_NAME_COLLATION)
    .select('_id')
    .lean();

  if (categoryWithName) {
    throw new ApiError(409, 'A category with this name already exists');
  }

  const categoryWithSlug = await Category.findOne({
    ...exclusion,
    slug,
  })
    .select('_id')
    .lean();

  if (categoryWithSlug) {
    throw new ApiError(409, 'A category with this slug already exists');
  }
};

const listCategories = async ({ page, limit, search, status }) => {
  const filter = {};

  if (status) {
    filter.status = status;
  }

  if (search) {
    filter.name = { $regex: escapeRegex(search), $options: 'i' };
  }

  const skip = (page - 1) * limit;
  const [categories, total] = await Promise.all([
    Category.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Category.countDocuments(filter),
  ]);

  return {
    categories,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

const getCategoryById = async (categoryId) => {
  const category = await Category.findById(categoryId).lean();

  if (!category) {
    throw new ApiError(404, 'Category not found');
  }

  return category;
};

const createCategory = async (payload) => {
  const name = normalizeName(payload.name);
  const slug = payload.slug || createSlug(name);

  if (!slug) {
    throw new ApiError(400, 'A valid category slug could not be generated');
  }

  await ensureUniqueCategory({ name, slug });

  try {
    return await Category.create({
      ...payload,
      name,
      slug,
    });
  } catch (error) {
    const duplicateError = duplicateCategoryError(error);

    if (duplicateError) {
      throw duplicateError;
    }

    throw error;
  }
};

const updateCategory = async (categoryId, payload) => {
  const category = await Category.findById(categoryId);

  if (!category) {
    throw new ApiError(404, 'Category not found');
  }

  const name = payload.name ? normalizeName(payload.name) : category.name;
  const slug =
    payload.slug || (payload.name ? createSlug(name) : category.slug);

  if (!slug) {
    throw new ApiError(400, 'A valid category slug could not be generated');
  }

  await ensureUniqueCategory({ name, slug, excludeId: categoryId });

  Object.assign(category, payload, { name, slug });

  try {
    return await category.save();
  } catch (error) {
    const duplicateError = duplicateCategoryError(error);

    if (duplicateError) {
      throw duplicateError;
    }

    throw error;
  }
};

const deactivateCategory = async (categoryId) => {
  const category = await Category.findById(categoryId);

  if (!category) {
    throw new ApiError(404, 'Category not found');
  }

  if (category.status !== 'inactive') {
    category.status = 'inactive';
    await category.save();
  }

  return category;
};

module.exports = {
  createCategorySlug: createSlug,
  createCategory,
  deactivateCategory,
  getCategoryById,
  listCategories,
  updateCategory,
};
