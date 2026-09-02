const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const service = require('./sizeSet.service');

module.exports = {
  listSizeSets: asyncHandler(async (req, res) => res.status(200).json(new ApiResponse(200, await service.listSizeSets(req.validated.query), 'SizeSets retrieved successfully'))),
  createSizeSet: asyncHandler(async (req, res) => res.status(201).json(new ApiResponse(201, await service.createSizeSet(req.validated.body), 'SizeSet created successfully'))),
  getSizeSet: asyncHandler(async (req, res) => res.status(200).json(new ApiResponse(200, await service.getSizeSetById(req.validated.params.id), 'SizeSet retrieved successfully'))),
  updateSizeSet: asyncHandler(async (req, res) => res.status(200).json(new ApiResponse(200, await service.updateSizeSet(req.validated.params.id, req.validated.body), 'SizeSet updated successfully'))),
  deactivateSizeSet: asyncHandler(async (req, res) => res.status(200).json(new ApiResponse(200, await service.deactivateSizeSet(req.validated.params.id), 'SizeSet deactivated successfully'))),
};
