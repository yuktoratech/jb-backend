const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const catalogMigrationService = require('./catalogMigration.service');

const hasOwn = (value, property) =>
  Object.prototype.hasOwnProperty.call(value, property);

const normalizeServiceResult = (result, fallbackMessage) => {
  const isObject = result !== null && typeof result === 'object';
  const isEnvelope =
    isObject &&
    (hasOwn(result, 'statusCode') ||
      hasOwn(result, 'message') ||
      hasOwn(result, 'data'));

  if (!isEnvelope) {
    return {
      statusCode: 200,
      message: fallbackMessage,
      data: result ?? null,
    };
  }

  const statusCode =
    Number.isInteger(result.statusCode) &&
    result.statusCode >= 200 &&
    result.statusCode <= 599
      ? result.statusCode
      : 200;

  return {
    statusCode,
    message:
      typeof result.message === 'string' && result.message.trim()
        ? result.message
        : fallbackMessage,
    data: hasOwn(result, 'data') ? (result.data ?? null) : result,
  };
};

const dryRunCatalogMigration = asyncHandler(async (req, res) => {
  const result = await catalogMigrationService.dryRunCatalogMigration(
    req.file.buffer,
    {
      originalName: req.file.originalname,
      sampleSize: req.validated.query.sampleSize,
    },
  );
  const response = normalizeServiceResult(
    result,
    'Catalog migration dry run completed',
  );

  return res
    .status(200)
    .json(new ApiResponse(200, response.data, response.message));
});

const importCatalogMigration = asyncHandler(async (req, res) => {
  const result = await catalogMigrationService.importCatalogMigration(
    req.file.buffer,
    {
      originalName: req.file.originalname,
      sampleSize: req.validated.query.sampleSize,
      performedBy: req.user._id,
    },
  );
  const response = normalizeServiceResult(
    result,
    'Catalog migration import completed',
  );

  if (response.statusCode >= 400) {
    return res.status(response.statusCode).json({
      success: false,
      statusCode: response.statusCode,
      message: response.message,
      data: response.data,
    });
  }

  return res
    .status(response.statusCode)
    .json(
      new ApiResponse(response.statusCode, response.data, response.message),
    );
});

module.exports = {
  dryRunCatalogMigration,
  importCatalogMigration,
};
