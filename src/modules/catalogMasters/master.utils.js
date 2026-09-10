const ApiError = require('../../utils/ApiError');

const MASTER_NAME_COLLATION = { locale: 'en', strength: 2 };

const normalizeName = (value) => value.trim().replace(/\s+/g, ' ');

const escapeRegex = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const validationApiError = (error) =>
  error?.name === 'ValidationError'
    ? new ApiError(
        400,
        'Validation failed',
        Object.values(error.errors).map((validationError) => ({
          field: validationError.path,
          message: validationError.message,
        })),
      )
    : null;

module.exports = {
  MASTER_NAME_COLLATION,
  escapeRegex,
  normalizeName,
  validationApiError,
};
