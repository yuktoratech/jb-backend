const express = require('express');

const authenticate = require('../../middleware/auth.middleware');
const authorize = require('../../middleware/authorize.middleware');
const validate = require('../../middleware/validate.middleware');
const catalogMigrationController = require('./catalogMigration.controller');
const uploadCatalogMigration = require('./catalogMigrationUpload.middleware');
const {
  catalogMigrationQuerySchema,
} = require('./catalogMigration.validation');

const router = express.Router();

router.use(authenticate, authorize('admin'));

router.post(
  '/dry-run',
  validate(catalogMigrationQuerySchema),
  uploadCatalogMigration,
  catalogMigrationController.dryRunCatalogMigration,
);

router.post(
  '/import',
  validate(catalogMigrationQuerySchema),
  uploadCatalogMigration,
  catalogMigrationController.importCatalogMigration,
);

module.exports = router;
