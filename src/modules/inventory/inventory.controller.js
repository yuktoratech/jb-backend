const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const inventoryService = require('./inventory.service');

const listInventory = asyncHandler(async (req, res) => {
  const data = await inventoryService.listInventory(req.validated.query);

  res
    .status(200)
    .json(new ApiResponse(200, data, 'Inventory retrieved successfully'));
});

const getInventoryByVariantId = asyncHandler(async (req, res) => {
  const data = await inventoryService.getInventoryByVariantId(
    req.validated.params.variantId,
  );

  res
    .status(200)
    .json(new ApiResponse(200, data, 'Inventory retrieved successfully'));
});

const getInventoryBySku = asyncHandler(async (req, res) => {
  const data = await inventoryService.getInventoryBySku(
    req.validated.params.sku,
  );

  res
    .status(200)
    .json(new ApiResponse(200, data, 'Inventory retrieved successfully'));
});

const adjustInventory = asyncHandler(async (req, res) => {
  const data = await inventoryService.adjustInventory(req.validated.body, {
    source: 'admin',
    performedBy: req.user._id,
  });

  res
    .status(200)
    .json(new ApiResponse(200, data, 'Inventory adjusted successfully'));
});

const listTransactions = asyncHandler(async (req, res) => {
  const data = await inventoryService.listTransactions(
    req.validated.params.variantId,
    req.validated.query,
  );

  res
    .status(200)
    .json(
      new ApiResponse(
        200,
        data,
        'Inventory transactions retrieved successfully',
      ),
    );
});

const importAdjustments = asyncHandler(async (req, res) => {
  const result = await inventoryService.importAdjustments(req.file.buffer, {
    source: 'import',
    performedBy: req.user._id,
    originalName: req.file.originalname,
  });

  if (result?.success === false) {
    return res.status(result.statusCode || 400).json({
      success: false,
      message:
        result.message ||
        'Inventory adjustment file contains validation errors',
      data: result.data || null,
    });
  }

  const statusCode = result?.statusCode || 200;
  const message =
    result?.message || 'Inventory adjustments imported successfully';
  const data =
    result?.success === true ? (result.data ?? null) : (result ?? null);

  return res.status(statusCode).json(new ApiResponse(statusCode, data, message));
});

module.exports = {
  adjustInventory,
  getInventoryBySku,
  getInventoryByVariantId,
  importAdjustments,
  listInventory,
  listTransactions,
};
