const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../users/user.model');
const ApiError = require('../../utils/ApiError');
const { generateAccessToken } = require('../../utils/jwt');
const {
  ensureActiveWholesalerForRetailer,
} = require('../users/account.service');
const { toSafeAccount } = require('../users/account.utils');
const { deliverPasswordResetToken } = require('./resetTokenDelivery.service');

const RESET_RESPONSE = 'If an account exists for that email, password reset instructions have been prepared';
const resetTtlMinutes = () => {
  const value = Number(process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES);
  return Number.isSafeInteger(value) && value > 0 ? value : 30;
};
const hashResetToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

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

const forgotPassword = async ({ email }) => {
  const user = await User.findOne({ email }).select('_id email');
  if (!user) {
    crypto.randomBytes(32);
    return { message: RESET_RESPONSE };
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + resetTtlMinutes() * 60 * 1000);
  await User.updateOne(
    { _id: user._id },
    { $set: { passwordResetTokenHash: hashResetToken(token), passwordResetExpiresAt: expiresAt } },
  );
  try {
    await deliverPasswordResetToken({ userId: user._id, email: user.email, token, expiresAt });
  } catch (error) {
    // Delivery is deliberately decoupled. Its availability must not reveal account existence.
  }
  return { message: RESET_RESPONSE };
};

const resetPassword = async ({ token, newPassword }) => {
  const password = await bcrypt.hash(newPassword, 12);
  const user = await User.findOneAndUpdate(
    { passwordResetTokenHash: hashResetToken(token), passwordResetExpiresAt: { $gt: new Date() } },
    { $set: { password }, $unset: { passwordResetTokenHash: 1, passwordResetExpiresAt: 1 } },
    { returnDocument: 'after', runValidators: true },
  );
  if (!user) throw new ApiError(400, 'Reset token is invalid or expired');
  return { message: 'Password reset successfully' };
};

const changePassword = async ({ currentPassword, newPassword }, actor) => {
  const user = await User.findOne({ _id: actor._id, status: 'active' }).select('+password');
  if (!user) throw new ApiError(401, 'Active account not found');
  if (!await user.comparePassword(currentPassword)) throw new ApiError(400, 'Current password is incorrect');
  if (await user.comparePassword(newPassword)) throw new ApiError(400, 'New password must be different from current password');
  user.password = newPassword;
  user.passwordResetTokenHash = undefined;
  user.passwordResetExpiresAt = undefined;
  await user.save();
  return { message: 'Password changed successfully' };
};

module.exports = { changePassword, forgotPassword, login, resetPassword };
