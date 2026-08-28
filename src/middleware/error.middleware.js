const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const isDevelopment = process.env.NODE_ENV === 'development';
  const isInternalError = statusCode >= 500;

  const response = {
    success: false,
    message:
      isInternalError && !isDevelopment
        ? 'Internal server error'
        : err.message || 'Internal server error',
    errors: isInternalError && !isDevelopment ? [] : err.errors || [],
  };

  if (isDevelopment) {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
};

module.exports = errorHandler;
