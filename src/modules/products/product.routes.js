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

router.use(authenticate);

router
  .route('/')
  .get(authorize('admin', 'wholesaler', 'retailer'), validate(listProductsSchema), productController.listProducts)
  .post(authorize('admin'), validate(createProductSchema), productController.createProduct);

router
  .route('/:id/variants')
  .get(authorize('admin', 'wholesaler', 'retailer'), validate(listVariantsSchema), productController.listProductVariants)
  .post(authorize('admin'), validate(createVariantSchema), productController.createVariant);

router.delete(
  '/:id/permanent',
  authorize('admin'),
  validate(productIdSchema),
  productController.permanentlyDeleteProduct,
);

router
  .route('/:id')
  .get(authorize('admin', 'wholesaler', 'retailer'), validate(productIdSchema), productController.getProduct)
  .patch(authorize('admin'), validate(updateProductSchema), productController.updateProduct)
  .delete(authorize('admin'), validate(productIdSchema), productController.deleteProduct);

module.exports = router;
