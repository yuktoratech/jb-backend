const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const wholesalerService = require('./wholesaler.service');

const listWholesalers = asyncHandler(async (req, res) => {
  const data = await wholesalerService.listWholesalers(req.validated.query);
  res
    .status(200)
    .json(new ApiResponse(200, data, 'Wholesalers retrieved successfully'));
});

const createWholesaler = asyncHandler(async (req, res) => {
  const data = await wholesalerService.createWholesaler(req.validated.body);
  res
    .status(201)
    .json(new ApiResponse(201, data, 'Wholesaler created successfully'));
});

const getWholesaler = asyncHandler(async (req, res) => {
  const data = await wholesalerService.getWholesalerById(
    req.validated.params.id,
  );
  res
    .status(200)
    .json(new ApiResponse(200, data, 'Wholesaler retrieved successfully'));
});

const updateWholesaler = asyncHandler(async (req, res) => {
  const data = await wholesalerService.updateWholesaler(
    req.validated.params.id,
    req.validated.body,
  );
  res
    .status(200)
    .json(new ApiResponse(200, data, 'Wholesaler updated successfully'));
});

const updateWholesalerStatus = asyncHandler(async (req, res) => {
  const data = await wholesalerService.updateWholesalerStatus(
    req.validated.params.id,
    req.validated.body.status,
  );
  res
    .status(200)
    .json(new ApiResponse(200, data, 'Wholesaler status updated successfully'));
});

module.exports = {
  createWholesaler,
  getWholesaler,
  listWholesalers,
  updateWholesaler,
  updateWholesalerStatus,
};
