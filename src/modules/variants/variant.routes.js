const express = require('express');

const authenticate = require('../../middleware/auth.middleware');
const authorize = require('../../middleware/authorize.middleware');
const validate = require('../../middleware/validate.middleware');
const {
  updateVariantSchema,
  variantIdSchema,
} = require('../products/product.validation');
const variantController = require('./variant.controller');

const router = express.Router();

router.use(authenticate, authorize('admin'));

router
  .route('/:id')
  .patch(validate(updateVariantSchema), variantController.updateVariant)
  .delete(validate(variantIdSchema), variantController.deleteVariant);

module.exports = router;
