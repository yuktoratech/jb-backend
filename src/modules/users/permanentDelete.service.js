const mongoose = require('mongoose');
const Address = require('../addresses/address.model');
const ImportBatch = require('../inventory/importBatch.model');
const InventoryTransaction = require('../inventory/inventoryTransaction.model');
const DeviceToken = require('../notifications/deviceToken.model');
const NotificationOutbox = require('../notifications/notificationOutbox.model');
const Order = require('../orders/order.model');
const ProductImportBatch = require('../productImports/productImport.model');
const User = require('./user.model');
const ApiError = require('../../utils/ApiError');

const exists = (Model, filter, session) => Model.exists(filter).session(session || null);

const hasAccountHistory = async (userId, session) => {
  if (await exists(Order, { $or: [
    { placedBy: userId }, { wholesaler: userId }, { retailer: userId }, { confirmedBy: userId },
    { 'history.performedBy': userId },
  ] }, session)) return true;
  if (await exists(InventoryTransaction, { performedBy: userId }, session)) return true;
  if (await exists(ProductImportBatch, { $or: [{ uploadedBy: userId }, { appliedBy: userId }] }, session)) return true;
  if (await exists(ImportBatch, { $or: [{ uploadedBy: userId }, { appliedBy: userId }] }, session)) return true;
  return Boolean(await exists(NotificationOutbox, { recipientUserIds: userId }, session));
};

const permanentlyDeleteAccount = async ({ userId, role, dependencyMessage, blockOwnedRetailers = false }) => {
  const account = await User.findOne({ _id: userId, role }).select('_id').lean();
  if (!account) throw new ApiError(404, `${role === 'wholesaler' ? 'Wholesaler' : 'Retailer'} not found`);

  const [hasRetailers, hasHistory] = await Promise.all([
    blockOwnedRetailers ? User.exists({ role: 'retailer', parentWholesaler: userId }) : false,
    hasAccountHistory(userId),
  ]);
  if (hasRetailers || hasHistory) throw new ApiError(409, dependencyMessage);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const currentRetailers = blockOwnedRetailers ? await exists(User, { role: 'retailer', parentWholesaler: userId }, session) : false;
      const currentHistory = await hasAccountHistory(userId, session);
      if (currentRetailers || currentHistory) throw new ApiError(409, dependencyMessage);
      await Address.deleteMany({ user: userId }, { session });
      await DeviceToken.deleteMany({ user: userId }, { session });
      const deleted = await User.deleteOne({ _id: userId, role }, { session });
      if (deleted.deletedCount !== 1) throw new ApiError(409, 'Account changed while permanent deletion was in progress');
    });
  } finally {
    await session.endSession();
  }
};

module.exports = { permanentlyDeleteAccount };
