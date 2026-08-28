const ApiError = require('../utils/ApiError');

const requestLocations = ['body', 'params', 'query'];

const validate = (schemas) => (req, res, next) => {
  const parsedValues = {};
  const validationErrors = [];

  requestLocations.forEach((location) => {
    const schema = schemas[location];

    if (!schema) {
      return;
    }

    const result = schema.safeParse(req[location]);

    if (!result.success) {
      validationErrors.push(
        ...result.error.issues.map((issue) => ({
          field: [location, ...issue.path].join('.'),
          message: issue.message,
        })),
      );
      return;
    }

    parsedValues[location] = result.data;
  });

  if (validationErrors.length > 0) {
    return next(new ApiError(400, 'Validation failed', validationErrors));
  }

  req.validated = {
    ...(req.validated || {}),
    ...parsedValues,
  };

  if (parsedValues.body) {
    req.body = parsedValues.body;
  }

  if (parsedValues.params) {
    req.params = parsedValues.params;
  }

  return next();
};

module.exports = validate;
