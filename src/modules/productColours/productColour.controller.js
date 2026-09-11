const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const service = require('./productColour.service');

module.exports = {
  list: asyncHandler(async (req, res) => res.status(200).json(new ApiResponse(200, await service.listProductColours(req.validated.query), 'ProductColours retrieved successfully'))),
  create: asyncHandler(async (req, res) => res.status(201).json(new ApiResponse(201, await service.createProductColour(req.validated.body), 'ProductColour created successfully'))),
  get: asyncHandler(async (req, res) => res.status(200).json(new ApiResponse(200, await service.getProductColourById(req.validated.params.id), 'ProductColour retrieved successfully'))),
  update: asyncHandler(async (req, res) => res.status(200).json(new ApiResponse(200, await service.updateProductColour(req.validated.params.id, req.validated.body), 'ProductColour updated successfully'))),
  deactivate: asyncHandler(async (req, res) => res.status(200).json(new ApiResponse(200, await service.deactivateProductColour(req.validated.params.id), 'ProductColour deactivated successfully'))),
  uploadImage: asyncHandler(async (req, res) => res.status(201).json(new ApiResponse(201, await service.uploadImages(req.validated.params.id, req.files, req.validated.body), 'ProductColour images uploaded successfully'))),
  deleteImage: asyncHandler(async (req, res) => res.status(200).json(new ApiResponse(200, await service.deleteImage(req.validated.params.id, req.validated.params.imageId), 'ProductColour image deleted successfully'))),
  reorderImages: asyncHandler(async (req, res) => res.status(200).json(new ApiResponse(200, await service.reorderImages(req.validated.params.id, req.validated.body.imageIds), 'ProductColour images reordered successfully'))),
};
