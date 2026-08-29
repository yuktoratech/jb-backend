const express = require('express');

const authenticate = require('../../middleware/auth.middleware');
const authorize = require('../../middleware/authorize.middleware');
const validate = require('../../middleware/validate.middleware');
const inventoryController = require('./inventory.controller');
const uploadInventoryAdjustments = require('./inventoryUpload.middleware');
const {
  adjustInventorySchema,
  inventoryBySkuSchema,
  inventoryByVariantSchema,
  listInventorySchema,
  listTransactionsSchema,
} = require('./inventory.validation');

const router = express.Router();

router.use(authenticate, authorize('admin'));

router.get(
  '/',
  validate(listInventorySchema),
  inventoryController.listInventory,
);

router.post(
  '/adjust',
  validate(adjustInventorySchema),
  inventoryController.adjustInventory,
);

router.post(
  '/import-adjustments',
  uploadInventoryAdjustments,
  inventoryController.importAdjustments,
);

router.get(
  '/sku/:sku',
  validate(inventoryBySkuSchema),
  inventoryController.getInventoryBySku,
);

router.get(
  '/:variantId/transactions',
  validate(listTransactionsSchema),
  inventoryController.listTransactions,
);

router.get(
  '/:variantId',
  validate(inventoryByVariantSchema),
  inventoryController.getInventoryByVariantId,
);

module.exports = router;
