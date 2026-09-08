const express = require('express');
const authenticate = require('../../middleware/auth.middleware');
const authorize = require('../../middleware/authorize.middleware');
const validate = require('../../middleware/validate.middleware');
const controller = require('./productImport.controller');
const upload = require('./productImportUpload.middleware');
const { applyProductImportSchema } = require('./productImport.validation');

const router = express.Router();
router.use(authenticate, authorize('admin'));
router.post('/preview', upload, controller.preview);
router.post('/:batchId/apply', validate(applyProductImportSchema), controller.apply);
module.exports = router;
