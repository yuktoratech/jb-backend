const express = require('express');

const authenticate = require('../../middleware/auth.middleware');
const authorize = require('../../middleware/authorize.middleware');
const validate = require('../../middleware/validate.middleware');
const productController = require('./product.controller');
const {
  createProductSchema,
  createVariantSchema,
  listProductsSchema,
  listVariantsSchema,
  productIdSchema,
  updateProductSchema,
} = require('./product.validation');

const router = express.Router();

router.use(authenticate, authorize('admin'));

router
  .route('/')
  .get(validate(listProductsSchema), productController.listProducts)
  .post(validate(createProductSchema), productController.createProduct);

router
  .route('/:id/variants')
  .get(validate(listVariantsSchema), productController.listProductVariants)
  .post(validate(createVariantSchema), productController.createVariant);

router
  .route('/:id')
  .get(validate(productIdSchema), productController.getProduct)
  .patch(validate(updateProductSchema), productController.updateProduct)
  .delete(validate(productIdSchema), productController.deleteProduct);

module.exports = router;
