const nodemailer = require('nodemailer');

const DEFAULT_SMTP_PORT = 587;
const DEFAULT_TIMEOUT_MS = 10000;

const configurationError = (name) => new Error(`Password reset email is not configured: ${name}`);

const requiredEnvironmentValue = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw configurationError(name);
  return value;
};

const optionalPositiveInteger = (name, defaultValue) => {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) return defaultValue;
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) throw configurationError(name);
  return value;
};

const optionalBoolean = (name, defaultValue) => {
  const rawValue = process.env[name]?.trim().toLowerCase();
  if (!rawValue) return defaultValue;
  if (rawValue === 'true') return true;
  if (rawValue === 'false') return false;
  throw configurationError(name);
};

const readPasswordResetEmailConfig = () => {
  const host = requiredEnvironmentValue('SMTP_HOST');
  const port = optionalPositiveInteger('SMTP_PORT', DEFAULT_SMTP_PORT);
  if (port > 65535) throw configurationError('SMTP_PORT');

  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SMTP_PASSWORD;
  if (Boolean(user) !== Boolean(password)) throw configurationError('SMTP_USER and SMTP_PASSWORD');

  const configuredResetUrl = requiredEnvironmentValue('PASSWORD_RESET_URL');
  let resetUrl;
  try {
    resetUrl = new URL(configuredResetUrl);
  } catch {
    throw configurationError('PASSWORD_RESET_URL');
  }
  if (
    !['http:', 'https:'].includes(resetUrl.protocol)
    || resetUrl.username
    || resetUrl.password
    || resetUrl.search
    || resetUrl.hash
  ) {
    throw configurationError('PASSWORD_RESET_URL');
  }
  if (!['development', 'test'].includes(process.env.NODE_ENV) && resetUrl.protocol !== 'https:') {
    throw configurationError('PASSWORD_RESET_URL must use HTTPS outside development/test');
  }

  const secure = optionalBoolean('SMTP_SECURE', port === 465);

  return {
    from: requiredEnvironmentValue('EMAIL_FROM'),
    resetUrl,
    transport: {
      host,
      port,
      secure,
      ...(!secure ? { requireTLS: optionalBoolean('SMTP_REQUIRE_TLS', true) } : {}),
      connectionTimeout: optionalPositiveInteger('SMTP_CONNECTION_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
      greetingTimeout: optionalPositiveInteger('SMTP_GREETING_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
      socketTimeout: optionalPositiveInteger('SMTP_SOCKET_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
      ...(user && password ? { auth: { user, pass: password } } : {}),
    },
  };
};

const buildPasswordResetUrl = (configuredUrl, token) => {
  const resetUrl = new URL(configuredUrl.toString());
  resetUrl.searchParams.set('token', token);
  return resetUrl.toString();
};

const escapeHtml = (value) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const validateDelivery = ({ email, token, expiresAt } = {}) => {
  if (
    typeof email !== 'string'
    || !email.trim()
    || typeof token !== 'string'
    || !/^[a-f\d]{64}$/i.test(token)
    || !(expiresAt instanceof Date)
    || Number.isNaN(expiresAt.getTime())
  ) {
    throw new TypeError('A valid password reset email delivery is required');
  }
};

const createSmtpPasswordResetDelivery = ({ createTransport = nodemailer.createTransport } = {}) => {
  if (typeof createTransport !== 'function') throw new TypeError('SMTP transport factory must be a function');

  let transporter;

  return async (delivery) => {
    validateDelivery(delivery);
    const config = readPasswordResetEmailConfig();
    const resetUrl = buildPasswordResetUrl(config.resetUrl, delivery.token);
    const expiresAt = delivery.expiresAt.toISOString();

    if (!transporter) transporter = createTransport(config.transport);

    await transporter.sendMail({
      from: config.from,
      to: delivery.email.trim(),
      subject: 'Reset your Just BLACK password',
      text: [
        'A password reset was requested for your Just BLACK account.',
        '',
        `Reset your password: ${resetUrl}`,
        `This link expires at ${expiresAt}.`,
        '',
        'If you did not request this reset, you can ignore this email.',
      ].join('\n'),
      html: [
        '<p>A password reset was requested for your Just BLACK account.</p>',
        `<p><a href="${escapeHtml(resetUrl)}">Reset your password</a></p>`,
        `<p>This link expires at ${escapeHtml(expiresAt)}.</p>`,
        '<p>If you did not request this reset, you can ignore this email.</p>',
      ].join(''),
    });
  };
};

const deliverPasswordResetEmail = createSmtpPasswordResetDelivery();

module.exports = {
  buildPasswordResetUrl,
  createSmtpPasswordResetDelivery,
  deliverPasswordResetEmail,
  readPasswordResetEmailConfig,
};
