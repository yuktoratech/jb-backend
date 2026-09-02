const express = require('express');
const authenticate = require('../../middleware/auth.middleware');
const authorize = require('../../middleware/authorize.middleware');
const validate = require('../../middleware/validate.middleware');
const controller = require('./sizeSet.controller');
const validation = require('./sizeSet.validation');

const router = express.Router();
router.use(authenticate);
router.route('/').get(validate(validation.listSizeSetsSchema), controller.listSizeSets).post(authorize('admin'), validate(validation.createSizeSetSchema), controller.createSizeSet);
router.route('/:id').get(validate(validation.sizeSetIdSchema), controller.getSizeSet).patch(authorize('admin'), validate(validation.updateSizeSetSchema), controller.updateSizeSet).delete(authorize('admin'), validate(validation.sizeSetIdSchema), controller.deactivateSizeSet);

module.exports = router;
