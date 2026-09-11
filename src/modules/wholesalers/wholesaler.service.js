const User = require('../users/user.model');
const Order = require('../orders/order.model');
const ApiError = require('../../utils/ApiError');
const {
  createManagedAccount,
  updateManagedAccount,
  updateManagedAccountStatus,
} = require('../users/account.service');
const { toSafeAccount } = require('../users/account.utils');
const { permanentlyDeleteAccount } = require('../users/permanentDelete.service');

const escapeRegex = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const findWholesaler = async (wholesalerId) => {
  const wholesaler = await User.findOne({
    _id: wholesalerId,
    role: 'wholesaler',
  });

  if (!wholesaler) {
    throw new ApiError(404, 'Wholesaler not found');
  }

  return wholesaler;
};

const addRetailerCounts = async (wholesalers) => {
  if (wholesalers.length === 0) {
    return [];
  }

  const counts = await User.aggregate([
    {
      $match: {
        role: 'retailer',
        parentWholesaler: { $in: wholesalers.map(({ _id }) => _id) },
      },
    },
    { $group: { _id: '$parentWholesaler', count: { $sum: 1 } } },
  ]);
  const countByWholesaler = new Map(
    counts.map(({ _id, count }) => [_id.toString(), count]),
  );

  return wholesalers.map((wholesaler) => ({
    ...toSafeAccount(wholesaler),
    retailerCount: countByWholesaler.get(wholesaler._id.toString()) || 0,
  }));
};

const listWholesalers = async ({ page, limit, search, status }) => {
  const filter = { role: 'wholesaler' };

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
  const [wholesalers, total] = await Promise.all([
    User.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    User.countDocuments(filter),
  ]);

  return {
    wholesalers: await addRetailerCounts(wholesalers),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

const createWholesaler = (payload) =>
  createManagedAccount({
    ...payload,
    role: 'wholesaler',
    parentWholesaler: null,
  });

const getWholesalerById = async (wholesalerId) => {
  const wholesaler = await findWholesaler(wholesalerId);
  const retailerCount = await User.countDocuments({
    role: 'retailer',
    parentWholesaler: wholesaler._id,
  });

  return {
    ...toSafeAccount(wholesaler),
    retailerCount,
  };
};

const updateWholesaler = async (wholesalerId, payload) => {
  const wholesaler = await findWholesaler(wholesalerId);
  return updateManagedAccount(wholesaler, payload);
};

const updateWholesalerStatus = async (wholesalerId, status) => {
  const wholesaler = await findWholesaler(wholesalerId);

  if (status === 'inactive' && wholesaler.status !== 'inactive') {
    const pendingRetailerOrder = await Order.exists({
      wholesaler: wholesaler._id,
      sourceRole: 'retailer',
      status: 'PENDING_WHOLESALER',
    });

    if (pendingRetailerOrder) {
      throw new ApiError(
        409,
        'Wholesaler has Retailer orders awaiting approval; forward or cancel them before deactivation',
      );
    }
  }

  return updateManagedAccountStatus(wholesaler, status);
};

const permanentlyDeleteWholesaler = (wholesalerId) => permanentlyDeleteAccount({
  userId: wholesalerId,
  role: 'wholesaler',
  blockOwnedRetailers: true,
  dependencyMessage: 'Cannot permanently delete this wholesaler because related retailers or order history exist.',
});

module.exports = {
  createWholesaler,
  getWholesalerById,
  listWholesalers,
  permanentlyDeleteWholesaler,
  updateWholesaler,
  updateWholesalerStatus,
};
