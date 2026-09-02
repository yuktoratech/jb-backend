const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const service = require('./address.service');

const list = asyncHandler(async (req, res) => res.status(200).json(new ApiResponse(200, await service.listAddresses(req.user._id), 'Addresses retrieved successfully')));
const create = asyncHandler(async (req, res) => res.status(201).json(new ApiResponse(201, await service.createAddress(req.validated.body, req.user._id), 'Address created successfully')));
const get = asyncHandler(async (req, res) => res.status(200).json(new ApiResponse(200, await service.getAddress(req.validated.params.id, req.user._id), 'Address retrieved successfully')));
const update = asyncHandler(async (req, res) => res.status(200).json(new ApiResponse(200, await service.updateAddress(req.validated.params.id, req.validated.body, req.user._id), 'Address updated successfully')));
const remove = asyncHandler(async (req, res) => res.status(200).json(new ApiResponse(200, await service.deleteAddress(req.validated.params.id, req.user._id), 'Address deleted successfully')));
const makeDefault = asyncHandler(async (req, res) => res.status(200).json(new ApiResponse(200, await service.setDefaultAddress(req.validated.params.id, req.user._id), 'Default address updated successfully')));

module.exports = { create, get, list, makeDefault, remove, update };
