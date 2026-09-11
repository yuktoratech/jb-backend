const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const retailerService = require('./retailer.service');

const listRetailers = asyncHandler(async (req, res) => {
  const data = await retailerService.listRetailers(
    req.validated.query,
    req.user,
  );
  res
    .status(200)
    .json(new ApiResponse(200, data, 'Retailers retrieved successfully'));
});

const createRetailer = asyncHandler(async (req, res) => {
  const data = await retailerService.createRetailer(
    req.validated.body,
    req.user,
  );
  res
    .status(201)
    .json(new ApiResponse(201, data, 'Retailer created successfully'));
});

const getRetailer = asyncHandler(async (req, res) => {
  const data = await retailerService.getRetailerById(
    req.validated.params.id,
    req.user,
  );
  res
    .status(200)
    .json(new ApiResponse(200, data, 'Retailer retrieved successfully'));
});

const updateRetailer = asyncHandler(async (req, res) => {
  const data = await retailerService.updateRetailer(
    req.validated.params.id,
    req.validated.body,
    req.user,
  );
  res
    .status(200)
    .json(new ApiResponse(200, data, 'Retailer updated successfully'));
});

const updateRetailerStatus = asyncHandler(async (req, res) => {
  const data = await retailerService.updateRetailerStatus(
    req.validated.params.id,
    req.validated.body.status,
    req.user,
  );
  res
    .status(200)
    .json(new ApiResponse(200, data, 'Retailer status updated successfully'));
});

const permanentlyDeleteRetailer = asyncHandler(async (req, res) => {
  await retailerService.permanentlyDeleteRetailer(req.validated.params.id);
  res.status(200).json(new ApiResponse(200, null, 'Retailer permanently deleted successfully'));
});

module.exports = {
  createRetailer,
  getRetailer,
  listRetailers,
  permanentlyDeleteRetailer,
  updateRetailer,
  updateRetailerStatus,
};
