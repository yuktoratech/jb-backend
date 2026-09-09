const User = require('./user.model');
const ApiError = require('../../utils/ApiError');
const {
  generateTemporaryPassword,
  toSafeAccount,
} = require('./account.utils');

const mapAccountError = (error) => {
  if (error instanceof ApiError) {
    return error;
  }

  if (error?.code === 11000) {
    return new ApiError(409, 'An account with this email already exists');
  }

  if (error?.name === 'VersionError') {
    return new ApiError(409, 'Account changed concurrently; please retry');
  }

  if (error?.name === 'ValidationError') {
    return new ApiError(
      400,
      'Validation failed',
      Object.values(error.errors).map((validationError) => ({
        field: validationError.path,
        message: validationError.message,
      })),
    );
  }

  return error;
};

const ensureEmailAvailable = async (email, excludeUserId) => {
  const filter = { email };

  if (excludeUserId) {
    filter._id = { $ne: excludeUserId };
  }

  const existingAccount = await User.exists(filter);

  if (existingAccount) {
    throw new ApiError(409, 'An account with this email already exists');
  }
};

const createManagedAccount = async ({
  name,
  email,
  phone,
  role,
  parentWholesaler = null,
  discountPercent = 0,
}) => {
  if (!phone) {
    throw new ApiError(400, 'Phone is required');
  }
  await User.init();
  await ensureEmailAvailable(email);

  const temporaryPassword = generateTemporaryPassword();

  try {
    const user = await User.create({
      name,
      email,
      phone,
      password: temporaryPassword,
      role,
      status: 'active',
      isEmailVerified: false,
      parentWholesaler,
      discountPercent,
    });

    return {
      user: toSafeAccount(user),
      temporaryPassword,
    };
  } catch (error) {
    throw mapAccountError(error);
  }
};

const updateManagedAccount = async (account, payload) => {
  if (payload.email && payload.email !== account.email) {
    await ensureEmailAvailable(payload.email, account._id);
  }

  const fields = ['name', 'email', 'phone', 'discountPercent'];

  fields.forEach((field) => {
    if (payload[field] !== undefined) {
      account[field] = payload[field];
    }
  });

  try {
    await account.save();
    return toSafeAccount(account);
  } catch (error) {
    throw mapAccountError(error);
  }
};

const updateManagedAccountStatus = async (account, status) => {
  if (account.status !== status) {
    account.status = status;

    try {
      await account.save();
    } catch (error) {
      throw mapAccountError(error);
    }
  }

  return toSafeAccount(account);
};

const ensureActiveWholesalerForRetailer = async (account) => {
  if (account.role !== 'retailer') {
    return;
  }

  if (!account.parentWholesaler) {
    throw new ApiError(401, 'Account hierarchy is not active');
  }

  const activeParentExists = await User.exists({
    _id: account.parentWholesaler,
    role: 'wholesaler',
    status: 'active',
  });

  if (!activeParentExists) {
    throw new ApiError(401, 'Account hierarchy is not active');
  }
};

module.exports = {
  createManagedAccount,
  ensureActiveWholesalerForRetailer,
  ensureEmailAvailable,
  mapAccountError,
  updateManagedAccount,
  updateManagedAccountStatus,
};
