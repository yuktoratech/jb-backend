const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const authService = require('./auth.service');

const login = asyncHandler(async (req, res) => {
  const data = await authService.login(req.validated.body);

  res.status(200).json(new ApiResponse(200, data, 'Login successful'));
});

const getCurrentUser = asyncHandler(async (req, res) => {
  res
    .status(200)
    .json(
      new ApiResponse(200, req.user, 'Current user retrieved successfully'),
    );
});

module.exports = { login, getCurrentUser };
