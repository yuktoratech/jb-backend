const ApiError = require('../utils/ApiError');

const DEVELOPMENT_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

const configuredOrigins = () => {
  const value = process.env.CORS_ALLOWED_ORIGINS;
  if (value) return [...new Set(value.split(',').map((origin) => origin.trim()).filter(Boolean))];
  return ['development', 'test'].includes(process.env.NODE_ENV) ? DEVELOPMENT_ORIGINS : [];
};

const corsOptions = {
  origin(origin, callback) {
    if (!origin || configuredOrigins().includes(origin)) return callback(null, true);
    return callback(new ApiError(403, 'Origin is not allowed by CORS'));
  },
  credentials: true,
  optionsSuccessStatus: 204,
};

module.exports = { configuredOrigins, corsOptions };
