const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const User = require('../modules/users/user.model');
const {
  ensureActiveWholesalerForRetailer,
} = require('../modules/users/account.service');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

const authenticatedUserFields =
  '_id name email phone role status isEmailVerified lastLoginAt discountPercent parentWholesaler createdAt updatedAt';

const authenticate = asyncHandler(async (req, res, next) => {
  const authorizationHeader = req.get('authorization');
  const bearerMatch = authorizationHeader?.match(/^Bearer\s+(.+)$/i);

  if (!bearerMatch || !bearerMatch[1].trim()) {
    throw new ApiError(401, 'Authentication token is required');
  }

  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured');
  }

  let payload;

  try {
    payload = jwt.verify(bearerMatch[1].trim(), process.env.JWT_SECRET);
  } catch (error) {
    throw new ApiError(401, 'Invalid or expired token');
  }

  if (
    typeof payload !== 'object' ||
    !payload.userId ||
    !mongoose.isObjectIdOrHexString(payload.userId)
  ) {
    throw new ApiError(401, 'Invalid or expired token');
  }

  const user = await User.findById(payload.userId)
    .select(authenticatedUserFields)
    .lean();

  if (!user) {
    throw new ApiError(401, 'Authenticated user no longer exists');
  }

  if (user.status !== 'active') {
    throw new ApiError(401, 'Account is not active');
  }

  await ensureActiveWholesalerForRetailer(user);

  req.user = user;
  return next();
});

module.exports = authenticate;
