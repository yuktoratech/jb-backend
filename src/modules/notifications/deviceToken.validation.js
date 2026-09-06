const { z } = require('zod');

const registerDeviceSchema = { body: z.object({
  token: z.string({ error: 'FCM token is required' }).trim().min(20, 'FCM token is invalid').max(4096),
  platform: z.enum(['android', 'ios'], { error: 'Platform must be android or ios' }),
  deviceId: z.string().trim().min(1).max(255).optional(),
}).strict() };
const deviceIdSchema = { params: z.object({
  id: z.string({ error: 'Device token ID is required' }).trim().regex(/^[a-f\d]{24}$/i, 'A valid device token ID is required'),
}).strict() };

module.exports = { deviceIdSchema, registerDeviceSchema };
