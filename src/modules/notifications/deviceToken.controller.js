const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const service = require('./deviceToken.service');

const register = asyncHandler(async (req, res) => {
  const record = await service.registerDevice(req.validated.body, req.user._id);
  res.status(200).json(new ApiResponse(200, record, 'Device registered successfully'));
});
const unregister = asyncHandler(async (req, res) => {
  const record = await service.unregisterDevice(req.validated.params.id, req.user._id);
  res.status(200).json(new ApiResponse(200, record, 'Device unregistered successfully'));
});

module.exports = { register, unregister };
