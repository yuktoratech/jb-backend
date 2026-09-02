const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const Address = require('./address.model');

const SNAPSHOT_FIELDS = ['name', 'phone', 'addressLine1', 'addressLine2', 'city', 'state', 'postalCode'];
const toSnapshot = (address) => Object.fromEntries(SNAPSHOT_FIELDS.map((field) => [field, address[field] ?? '']));
const mapError = (error) => {
  if (error instanceof ApiError) return error;
  if (error?.code === 11000) return new ApiError(409, 'This user already has a default address; please retry');
  if (error?.name === 'VersionError' || error?.hasErrorLabel?.('TransientTransactionError')) return new ApiError(409, 'Address changed concurrently; please retry');
  return error;
};

const withDefaultTransaction = async (userId, work) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      await Address.updateMany({ user: userId, isDefault: true }, { $set: { isDefault: false } }, { session });
      result = await work(session);
    });
    return result;
  } catch (error) {
    throw mapError(error);
  } finally {
    await session.endSession();
  }
};

const listAddresses = (userId) => Address.find({ user: userId }).sort({ isDefault: -1, createdAt: -1, _id: -1 }).lean();
const getAddress = async (id, userId) => {
  const address = await Address.findOne({ _id: id, user: userId }).lean();
  if (!address) throw new ApiError(404, 'Address not found');
  return address;
};
const createAddress = async (payload, userId) => {
  try {
    if (payload.isDefault) return withDefaultTransaction(userId, async (session) => {
      const [address] = await Address.create([{ ...payload, user: userId, isDefault: true }], { session });
      return address;
    });
    return await Address.create({ ...payload, user: userId, isDefault: false });
  } catch (error) { throw mapError(error); }
};
const updateAddress = async (id, payload, userId) => {
  const update = async (session) => {
    const address = await Address.findOne({ _id: id, user: userId }).session(session || null);
    if (!address) throw new ApiError(404, 'Address not found');
    Object.assign(address, payload);
    await address.save(session ? { session } : undefined);
    return address;
  };
  try {
    return payload.isDefault === true ? withDefaultTransaction(userId, update) : await update();
  } catch (error) { throw mapError(error); }
};
const deleteAddress = async (id, userId) => {
  const address = await Address.findOneAndDelete({ _id: id, user: userId });
  if (!address) throw new ApiError(404, 'Address not found');
  return address;
};
const setDefaultAddress = (id, userId) => updateAddress(id, { isDefault: true }, userId);
const resolveOwnedSnapshot = async (id, userId) => toSnapshot(await getAddress(id, userId));

module.exports = { createAddress, deleteAddress, getAddress, listAddresses, resolveOwnedSnapshot, setDefaultAddress, toSnapshot, updateAddress };
