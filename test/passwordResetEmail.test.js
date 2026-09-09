const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');

const {
  createSmtpPasswordResetDelivery,
  readPasswordResetEmailConfig,
} = require('../src/modules/auth/smtpPasswordReset.provider');
const resetTokenDelivery = require('../src/modules/auth/resetTokenDelivery.service');

const ENVIRONMENT_KEYS = [
  'EMAIL_FROM',
  'NODE_ENV',
  'PASSWORD_RESET_URL',
  'SMTP_CONNECTION_TIMEOUT_MS',
  'SMTP_GREETING_TIMEOUT_MS',
  'SMTP_HOST',
  'SMTP_PASSWORD',
  'SMTP_PORT',
  'SMTP_REQUIRE_TLS',
  'SMTP_SECURE',
  'SMTP_SOCKET_TIMEOUT_MS',
  'SMTP_USER',
];
const originalEnvironment = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));

const restoreEnvironment = () => {
  for (const key of ENVIRONMENT_KEYS) {
    if (originalEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnvironment[key];
  }
};

const configureEmail = () => {
  process.env.EMAIL_FROM = 'Just BLACK <no-reply@example.test>';
  process.env.PASSWORD_RESET_URL = 'https://admin.example.test/reset-password';
  process.env.SMTP_HOST = 'smtp.example.test';
  process.env.SMTP_PORT = '465';
  process.env.SMTP_SECURE = 'true';
  process.env.SMTP_USER = 'smtp-user';
  process.env.SMTP_PASSWORD = 'smtp-password';
};

afterEach(() => {
  restoreEnvironment();
  resetTokenDelivery.resetPasswordResetDeliveryHandler();
});

test('SMTP password reset delivery builds a tokenized Admin link and sends it through configured transport', async () => {
  configureEmail();
  const token = 'a'.repeat(64);
  const expiresAt = new Date('2030-01-02T03:04:05.000Z');
  let transportOptions;
  let message;
  const deliver = createSmtpPasswordResetDelivery({
    createTransport: (options) => {
      transportOptions = options;
      return { sendMail: async (payload) => { message = payload; } };
    },
  });

  await deliver({ email: 'admin@example.test', token, expiresAt });

  assert.deepEqual(transportOptions, {
    host: 'smtp.example.test',
    port: 465,
    secure: true,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
    auth: { user: 'smtp-user', pass: 'smtp-password' },
  });
  assert.equal(message.from, 'Just BLACK <no-reply@example.test>');
  assert.equal(message.to, 'admin@example.test');
  assert.match(message.subject, /reset/i);
  assert.match(message.text, new RegExp(`https://admin\\.example\\.test/reset-password\\?token=${token}`));
  assert.match(message.text, /2030-01-02T03:04:05\.000Z/);
  assert.match(message.html, new RegExp(`token=${token}`));
});

test('SMTP configuration supports an unauthenticated relay and rejects partial credentials', () => {
  configureEmail();
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASSWORD;
  const config = readPasswordResetEmailConfig();
  assert.equal(Object.hasOwn(config.transport, 'auth'), false);

  process.env.SMTP_USER = 'smtp-user';
  assert.throws(() => readPasswordResetEmailConfig(), /SMTP_USER and SMTP_PASSWORD/);
});

test('SMTP requires STARTTLS by default and production reset links require HTTPS', () => {
  configureEmail();
  process.env.SMTP_PORT = '587';
  process.env.SMTP_SECURE = 'false';
  assert.equal(readPasswordResetEmailConfig().transport.requireTLS, true);

  process.env.PASSWORD_RESET_URL = 'http://admin.example.test/reset-password';
  process.env.NODE_ENV = 'production';
  assert.throws(() => readPasswordResetEmailConfig(), /HTTPS/);
  process.env.NODE_ENV = 'test';
  assert.equal(readPasswordResetEmailConfig().resetUrl.protocol, 'http:');
});

test('delivery configuration failures do not include the reset token', async () => {
  restoreEnvironment();
  for (const key of ENVIRONMENT_KEYS) delete process.env[key];
  const token = 'b'.repeat(64);
  const deliver = createSmtpPasswordResetDelivery({
    createTransport: () => { throw new Error('Transport must not be created'); },
  });

  await assert.rejects(
    deliver({ email: 'admin@example.test', token, expiresAt: new Date('2030-01-02T03:04:05.000Z') }),
    (error) => {
      assert.match(error.message, /SMTP_HOST/);
      assert.equal(error.message.includes(token), false);
      return true;
    },
  );
});

test('resetting an injected token handler restores the configured SMTP provider', async () => {
  restoreEnvironment();
  for (const key of ENVIRONMENT_KEYS) delete process.env[key];
  const token = 'c'.repeat(64);
  let captured;
  resetTokenDelivery.setPasswordResetDeliveryHandler(async (delivery) => { captured = delivery; });
  const payload = { email: 'admin@example.test', token, expiresAt: new Date('2030-01-02T03:04:05.000Z') };

  await resetTokenDelivery.deliverPasswordResetToken(payload);
  assert.equal(captured, payload);

  resetTokenDelivery.resetPasswordResetDeliveryHandler();
  await assert.rejects(
    resetTokenDelivery.deliverPasswordResetToken(payload),
    (error) => {
      assert.match(error.message, /SMTP_HOST/);
      assert.equal(error.message.includes(token), false);
      return true;
    },
  );
});
