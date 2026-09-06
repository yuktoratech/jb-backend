const mongoose = require('mongoose');

const deviceTokenSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  token: { type: String, required: true, trim: true, minlength: 20, maxlength: 4096 },
  platform: { type: String, enum: ['android', 'ios'], required: true },
  deviceId: { type: String, trim: true, minlength: 1, maxlength: 255 },
  status: { type: String, enum: ['active', 'inactive'], required: true, default: 'active' },
  lastSeenAt: { type: Date, required: true, default: Date.now },
  deactivatedAt: { type: Date },
}, { timestamps: true, optimisticConcurrency: true });

deviceTokenSchema.index({ token: 1 }, { unique: true, name: 'unique_fcm_registration_token' });
deviceTokenSchema.index({ user: 1, status: 1 }, { name: 'device_tokens_by_user_status' });
deviceTokenSchema.index(
  { user: 1, deviceId: 1 },
  {
    unique: true,
    name: 'unique_device_id_per_user',
    partialFilterExpression: { deviceId: { $type: 'string' } },
  },
);

module.exports = mongoose.model('DeviceToken', deviceTokenSchema);
