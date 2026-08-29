const User = require('../users/user.model');
const ApiError = require('../../utils/ApiError');
const { generateAccessToken } = require('../../utils/jwt');
const {
  ensureActiveWholesalerForRetailer,
} = require('../users/account.service');
const { toSafeAccount } = require('../users/account.utils');

const login = async ({ email, password }) => {
  const user = await User.findOne({ email }).select('+password');

  if (!user) {
    throw new ApiError(401, 'Invalid credentials');
  }

  const isPasswordValid = await user.comparePassword(password);

  if (!isPasswordValid) {
    throw new ApiError(401, 'Invalid credentials');
  }

  if (user.status !== 'active') {
    throw new ApiError(401, 'Account is not active');
  }

  await ensureActiveWholesalerForRetailer(user);

  const accessToken = generateAccessToken(user);
  const lastLoginAt = new Date();

  await User.updateOne(
    { _id: user._id },
    {
      $set: { lastLoginAt },
    },
  );

  user.lastLoginAt = lastLoginAt;

  return {
    accessToken,
    user: toSafeAccount(user),
  };
};

module.exports = { login };
