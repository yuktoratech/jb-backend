const ApiError = require('../../utils/ApiError');
const DeviceToken = require('./deviceToken.model');

const mapError = (error) => {
  if (error instanceof ApiError) return error;
  if (error?.code === 11000) return new ApiError(409, 'FCM token or device is already registered');
  if (error?.name === 'VersionError') return new ApiError(409, 'Device registration changed concurrently; please retry');
  return error;
};
const registerDevice = async (payload, userId) => {
  await DeviceToken.init();
  const tokenRecord = await DeviceToken.findOne({ token: payload.token });
  if (tokenRecord) {
    if (!tokenRecord.user.equals(userId)) throw new ApiError(409, 'FCM token is already registered to another account');
    if (payload.deviceId) {
      const deviceConflict = await DeviceToken.exists({ user: userId, deviceId: payload.deviceId, _id: { $ne: tokenRecord._id } });
      if (deviceConflict) throw new ApiError(409, 'Device ID is already associated with another token');
    }
    tokenRecord.platform = payload.platform;
    tokenRecord.deviceId = payload.deviceId;
    tokenRecord.status = 'active';
    tokenRecord.lastSeenAt = new Date();
    tokenRecord.deactivatedAt = undefined;
    try { return await tokenRecord.save(); } catch (error) { throw mapError(error); }
  }

  let deviceRecord = payload.deviceId
    ? await DeviceToken.findOne({ user: userId, deviceId: payload.deviceId })
    : null;
  if (!deviceRecord) deviceRecord = new DeviceToken({ user: userId });
  deviceRecord.token = payload.token;
  deviceRecord.platform = payload.platform;
  deviceRecord.deviceId = payload.deviceId;
  deviceRecord.status = 'active';
  deviceRecord.lastSeenAt = new Date();
  deviceRecord.deactivatedAt = undefined;
  try { return await deviceRecord.save(); } catch (error) {
    if (error?.code === 11000) {
      const concurrent = await DeviceToken.findOne({ token: payload.token });
      if (concurrent?.user.equals(userId)) return concurrent;
    }
    throw mapError(error);
  }
};

const unregisterDevice = async (id, userId) => {
  const record = await DeviceToken.findOne({ _id: id, user: userId });
  if (!record) throw new ApiError(404, 'Device registration not found');
  if (record.status !== 'inactive') {
    record.status = 'inactive';
    record.deactivatedAt = new Date();
    try { await record.save(); } catch (error) { throw mapError(error); }
  }
  return record;
};

module.exports = { registerDevice, unregisterDevice };
