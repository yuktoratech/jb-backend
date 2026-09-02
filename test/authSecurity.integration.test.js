const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.JWT_EXPIRES_IN = '1h';
process.env.CORS_ALLOWED_ORIGINS = 'https://allowed.example.test';
process.env.AUTH_LOGIN_RATE_LIMIT_MAX = '6';
process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS = '60000';
process.env.AUTH_FORGOT_RATE_LIMIT_MAX = '5';
process.env.AUTH_FORGOT_RATE_LIMIT_WINDOW_MS = '60000';
process.env.AUTH_RESET_RATE_LIMIT_MAX = '5';
process.env.AUTH_RESET_RATE_LIMIT_WINDOW_MS = '60000';
const URI = process.env.AUTH_SECURITY_TEST_MONGODB_URI;

const app = require('../src/app');
const delivery = require('../src/modules/auth/resetTokenDelivery.service');
const User = require('../src/modules/users/user.model');
const { generateAccessToken } = require('../src/utils/jwt');

const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

test('Auth completion and security controls', { timeout: 120000, skip: !URI && 'AUTH_SECURITY_TEST_MONGODB_URI is required' }, async (t) => {
  let server;
  try {
    await mongoose.connect(URI);
    await mongoose.connection.dropDatabase();
    const originalPassword = 'OriginalPass1';
    const [admin, wholesaler] = await User.create([
      { name: 'Auth Admin', email: 'auth-admin@example.test', password: originalPassword, role: 'admin', status: 'active' },
      { name: 'Auth Wholesaler', email: 'auth-wholesaler@example.test', phone: '9876543210', password: originalPassword, role: 'wholesaler', status: 'active' },
    ]);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const request = async (path, { method = 'GET', token, body, origin } = {}) => {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (origin) headers.Origin = origin;
      const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, headers: response.headers, body: await response.json() };
    };
    const post = (path, body, token) => request(path, { method: 'POST', body, token });

    let delivered;
    delivery.setPasswordResetDeliveryHandler(async (payload) => { delivered = payload; });

    await t.test('forgot response hides existence and stores only an expiring hash', async () => {
      const known = await post('/auth/forgot-password', { email: wholesaler.email });
      const knownMessage = known.body.message;
      assert.equal(known.status, 200); assert.ok(delivered?.token); assert.equal(delivered.token.length, 64);
      const stored = await User.findById(wholesaler._id).select('+passwordResetTokenHash +passwordResetExpiresAt').lean();
      assert.equal(stored.passwordResetTokenHash, hash(delivered.token)); assert.notEqual(stored.passwordResetTokenHash, delivered.token);
      assert.ok(stored.passwordResetExpiresAt > new Date());
      delivered = undefined;
      const unknown = await post('/auth/forgot-password', { email: 'missing@example.test' });
      assert.equal(unknown.status, 200); assert.equal(unknown.body.message, knownMessage); assert.equal(delivered, undefined);
      assert.equal(Object.hasOwn(known.body.data, 'token'), false);
    });

    await t.test('valid reset changes password and token cannot be reused', async () => {
      await post('/auth/forgot-password', { email: wholesaler.email });
      const token = delivered.token; const nextPassword = 'ResetPassword2';
      const reset = await post('/auth/reset-password', { token, newPassword: nextPassword });
      assert.equal(reset.status, 200);
      assert.equal((await post('/auth/login', { email: wholesaler.email, password: originalPassword })).status, 401);
      assert.equal((await post('/auth/login', { email: wholesaler.email, password: nextPassword })).status, 200);
      assert.equal((await post('/auth/reset-password', { token, newPassword: 'AnotherPassword3' })).status, 400);
      const stored = await User.findById(wholesaler._id).select('+passwordResetTokenHash +passwordResetExpiresAt').lean();
      assert.equal(stored.passwordResetTokenHash, undefined); assert.equal(stored.passwordResetExpiresAt, undefined);
    });

    await t.test('expired and malformed reset tokens are rejected', async () => {
      const expired = crypto.randomBytes(32).toString('hex');
      await User.updateOne({ _id: wholesaler._id }, { $set: { passwordResetTokenHash: hash(expired), passwordResetExpiresAt: new Date(Date.now() - 1000) } });
      assert.equal((await post('/auth/reset-password', { token: expired, newPassword: 'ExpiredPassword4' })).status, 400);
      assert.equal((await post('/auth/reset-password', { token: 'not-a-token', newPassword: 'MalformedPassword5' })).status, 400);
    });

    await t.test('authenticated password change verifies current password', async () => {
      const auth = generateAccessToken(wholesaler);
      const wrong = await post('/auth/change-password', { currentPassword: 'WrongPassword1', newPassword: 'ChangedPassword3' }, auth);
      assert.equal(wrong.status, 400);
      const changed = await post('/auth/change-password', { currentPassword: 'ResetPassword2', newPassword: 'ChangedPassword3' }, auth);
      assert.equal(changed.status, 200);
      assert.equal((await post('/auth/login', { email: wholesaler.email, password: 'ResetPassword2' })).status, 401);
      assert.equal((await post('/auth/login', { email: wholesaler.email, password: 'ChangedPassword3' })).status, 200);
    });

    await t.test('managed Wholesaler and Retailer creation requires phone', async () => {
      const adminToken = generateAccessToken(admin); const wholesalerToken = generateAccessToken(wholesaler);
      const missingWholesalerPhone = await post('/wholesalers', { name: 'No Phone Wholesale', email: 'no-phone-wholesale@example.test' }, adminToken);
      assert.equal(missingWholesalerPhone.status, 400);
      const missingRetailerPhone = await post('/retailers', { name: 'No Phone Retail', email: 'no-phone-retail@example.test' }, wholesalerToken);
      assert.equal(missingRetailerPhone.status, 400);
    });

    await t.test('configured CORS allowlist permits exact origin and rejects others', async () => {
      const allowed = await request('/health', { origin: 'https://allowed.example.test' });
      assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://allowed.example.test');
      const blocked = await request('/health', { origin: 'https://blocked.example.test' });
      assert.equal(blocked.status, 403); assert.equal(blocked.headers.get('access-control-allow-origin'), null);
    });

    await t.test('login, forgot, and reset limits return 429 after configured allowances', async () => {
      const statuses = [];
      for (let index = 0; index < 8; index += 1) statuses.push((await post('/auth/login', { email: 'attacker@example.test', password: 'WrongPassword1' })).status);
      assert.ok(statuses.includes(429)); assert.equal(statuses.at(-1), 429);
      const forgotStatuses = [];
      for (let index = 0; index < 4; index += 1) forgotStatuses.push((await post('/auth/forgot-password', { email: 'rate-limit-missing@example.test' })).status);
      assert.equal(forgotStatuses.at(-1), 429);
      const resetStatuses = [];
      for (let index = 0; index < 3; index += 1) resetStatuses.push((await post('/auth/reset-password', { token: 'malformed', newPassword: 'RateLimitPassword6' })).status);
      assert.equal(resetStatuses.at(-1), 429);
    });
  } finally {
    delivery.resetPasswordResetDeliveryHandler();
    if (server) await close(server);
    await mongoose.disconnect();
  }
});
