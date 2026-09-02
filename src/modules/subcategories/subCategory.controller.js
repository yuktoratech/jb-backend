const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const service = require('./subCategory.service');

module.exports = {
  listSubCategories: asyncHandler(async (req, res) => res.status(200).json(new ApiResponse(200, await service.listSubCategories(req.validated.query), 'SubCategories retrieved successfully'))),
  createSubCategory: asyncHandler(async (req, res) => res.status(201).json(new ApiResponse(201, await service.createSubCategory(req.validated.body), 'SubCategory created successfully'))),
  getSubCategory: asyncHandler(async (req, res) => res.status(200).json(new ApiResponse(200, await service.getSubCategoryById(req.validated.params.id), 'SubCategory retrieved successfully'))),
  updateSubCategory: asyncHandler(async (req, res) => res.status(200).json(new ApiResponse(200, await service.updateSubCategory(req.validated.params.id, req.validated.body), 'SubCategory updated successfully'))),
  deactivateSubCategory: asyncHandler(async (req, res) => res.status(200).json(new ApiResponse(200, await service.deactivateSubCategory(req.validated.params.id), 'SubCategory deactivated successfully'))),
};
