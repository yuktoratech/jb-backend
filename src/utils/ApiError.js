class ApiError extends Error {
  constructor(statusCode, message = 'Something went wrong', errors = []) {
    super(message);

    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.message = message;
    this.errors = errors;
    this.success = false;

    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = ApiError;
