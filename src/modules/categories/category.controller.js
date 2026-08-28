const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const categoryService = require('./category.service');

const listCategories = asyncHandler(async (req, res) => {
  const data = await categoryService.listCategories(req.validated.query);

  res
    .status(200)
    .json(new ApiResponse(200, data, 'Categories retrieved successfully'));
});

const createCategory = asyncHandler(async (req, res) => {
  const category = await categoryService.createCategory(req.validated.body);

  res
    .status(201)
    .json(new ApiResponse(201, category, 'Category created successfully'));
});

const getCategory = asyncHandler(async (req, res) => {
  const category = await categoryService.getCategoryById(
    req.validated.params.id,
  );

  res
    .status(200)
    .json(new ApiResponse(200, category, 'Category retrieved successfully'));
});

const updateCategory = asyncHandler(async (req, res) => {
  const category = await categoryService.updateCategory(
    req.validated.params.id,
    req.validated.body,
  );

  res
    .status(200)
    .json(new ApiResponse(200, category, 'Category updated successfully'));
});

const deleteCategory = asyncHandler(async (req, res) => {
  const category = await categoryService.deactivateCategory(
    req.validated.params.id,
  );

  res
    .status(200)
    .json(new ApiResponse(200, category, 'Category deactivated successfully'));
});

module.exports = {
  createCategory,
  deleteCategory,
  getCategory,
  listCategories,
  updateCategory,
};
