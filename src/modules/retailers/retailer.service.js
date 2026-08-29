const User = require('../users/user.model');
const ApiError = require('../../utils/ApiError');
const {
  createManagedAccount,
  updateManagedAccount,
  updateManagedAccountStatus,
} = require('../users/account.service');
const { toSafeAccount } = require('../users/account.utils');

const escapeRegex = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const formatRetailer = (retailer) => {
  const account = toSafeAccount(retailer);
  const parent = account.parentWholesaler;

  if (parent && typeof parent === 'object' && parent._id) {
    account.parentWholesaler = {
      _id: parent._id,
      name: parent.name,
      email: parent.email,
      status: parent.status,
    };
  }

  return account;
};

const buildRetailerFilter = (actor, retailerId) => {
  const filter = { role: 'retailer' };

  if (retailerId) {
    filter._id = retailerId;
  }

  if (actor.role === 'wholesaler') {
    filter.parentWholesaler = actor._id;
  } else if (actor.role !== 'admin') {
    throw new ApiError(403, 'You do not have permission to access retailers');
  }

  return filter;
};

const findRetailerForActor = async (retailerId, actor) => {
  const retailer = await User.findOne(buildRetailerFilter(actor, retailerId));

  if (!retailer) {
    throw new ApiError(404, 'Retailer not found');
  }

  return retailer;
};

const ensureWholesalerCanManageRetailers = async (actor) => {
  if (actor.role !== 'wholesaler') {
    throw new ApiError(
      403,
      'Only a Wholesaler can create or manage Retailers',
    );
  }

  const activeWholesalerExists = await User.exists({
    _id: actor._id,
    role: 'wholesaler',
    status: 'active',
  });

  if (!activeWholesalerExists) {
    throw new ApiError(401, 'Wholesaler account is not active');
  }
};

const listRetailers = async (
  { page, limit, search, status, wholesalerId },
  actor,
) => {
  const filter = buildRetailerFilter(actor);

  if (actor.role === 'admin' && wholesalerId) {
    filter.parentWholesaler = wholesalerId;
  }

  if (status) {
    filter.status = status;
  }

  if (search) {
    const expression = { $regex: escapeRegex(search), $options: 'i' };
    filter.$or = [
      { name: expression },
      { email: expression },
      { phone: expression },
    ];
  }

  const skip = (page - 1) * limit;
  const [retailers, total] = await Promise.all([
    User.find(filter)
      .populate('parentWholesaler', '_id name email status')
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    User.countDocuments(filter),
  ]);

  return {
    retailers: retailers.map(formatRetailer),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

const createRetailer = async (payload, actor) => {
  await ensureWholesalerCanManageRetailers(actor);

  const result = await createManagedAccount({
    ...payload,
    role: 'retailer',
    parentWholesaler: actor._id,
  });
  const retailer = await User.findById(result.user._id)
    .populate('parentWholesaler', '_id name email status')
    .lean();

  return {
    user: formatRetailer(retailer),
    temporaryPassword: result.temporaryPassword,
  };
};

const getRetailerById = async (retailerId, actor) => {
  const filter = buildRetailerFilter(actor, retailerId);
  const retailer = await User.findOne(filter)
    .populate('parentWholesaler', '_id name email status')
    .lean();

  if (!retailer) {
    throw new ApiError(404, 'Retailer not found');
  }

  return formatRetailer(retailer);
};

const updateRetailer = async (retailerId, payload, actor) => {
  await ensureWholesalerCanManageRetailers(actor);
  const retailer = await findRetailerForActor(retailerId, actor);
  await updateManagedAccount(retailer, payload);
  return getRetailerById(retailerId, actor);
};

const updateRetailerStatus = async (retailerId, status, actor) => {
  await ensureWholesalerCanManageRetailers(actor);
  const retailer = await findRetailerForActor(retailerId, actor);
  await updateManagedAccountStatus(retailer, status);
  return getRetailerById(retailerId, actor);
};

module.exports = {
  createRetailer,
  getRetailerById,
  listRetailers,
  updateRetailer,
  updateRetailerStatus,
};
