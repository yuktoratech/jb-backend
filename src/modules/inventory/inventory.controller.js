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

const previewImport = asyncHandler(async (req, res) => {
  const data = await inventoryService.previewImport(req.file.buffer, {
    performedBy: req.user._id,
    originalName: req.file.originalname,
  });
  return res.status(201).json(new ApiResponse(201, data, 'Inventory import preview created'));
});

const applyImport = asyncHandler(async (req, res) => {
  const data = await inventoryService.applyImport(
    req.validated.params.id,
    { performedBy: req.user._id },
  );
  return res.status(200).json(new ApiResponse(200, data, 'Inventory import applied successfully'));
});

module.exports = {
  adjustInventory,
  getInventoryBySku,
  getInventoryByVariantId,
  applyImport,
  listInventory,
  listTransactions,
  previewImport,
};
