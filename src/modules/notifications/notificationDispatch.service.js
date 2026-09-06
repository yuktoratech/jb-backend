const DeviceToken = require('./deviceToken.model');
const NotificationOutbox = require('./notificationOutbox.model');
const provider = require('./notificationProvider.service');

const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);
const chunksOf = (values, size) => {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
};

const dispatchOutbox = async (outboxId) => {
  const outbox = await NotificationOutbox.findById(outboxId);
  if (!outbox || !['PENDING', 'FAILED', 'PARTIAL'].includes(outbox.status)) return outbox;
  const devices = await DeviceToken.find({ user: { $in: outbox.recipientUserIds }, status: 'active' }).sort({ _id: 1 });
  outbox.attempts += 1;
  if (!devices.length) {
    outbox.status = 'NO_DEVICES'; outbox.deliveredAt = new Date(); outbox.lastError = undefined;
    await outbox.save(); return outbox;
  }
  let successCount = 0; let failureCount = 0; const deadIds = [];
  try {
    for (const chunk of chunksOf(devices, 500)) {
      const result = await provider.sendMulticast({
        tokens: chunk.map(({ token }) => token),
        title: outbox.title,
        body: outbox.body,
        data: Object.fromEntries(Object.entries(outbox.payload.toObject()).filter(([key]) => key !== '_id').map(([key, value]) => [key, String(value)])),
      });
      chunk.forEach((device, index) => {
        const response = result.responses[index];
        if (response?.success) successCount += 1;
        else {
          failureCount += 1;
          if (DEAD_TOKEN_CODES.has(response?.errorCode)) deadIds.push(device._id);
        }
      });
    }
    if (deadIds.length) await DeviceToken.updateMany({ _id: { $in: deadIds }, status: 'active' }, { $set: { status: 'inactive', deactivatedAt: new Date() } });
    outbox.status = failureCount === 0 ? 'DELIVERED' : successCount === 0 ? 'FAILED' : 'PARTIAL';
    outbox.deliveredAt = failureCount === 0 ? new Date() : undefined;
    outbox.lastError = failureCount ? `${failureCount} device delivery attempt(s) failed` : undefined;
  } catch (error) {
    outbox.status = 'FAILED'; outbox.lastError = String(error?.message || 'Notification provider failed').slice(0, 1000);
  }
  await outbox.save();
  return outbox;
};

module.exports = { DEAD_TOKEN_CODES, dispatchOutbox };
