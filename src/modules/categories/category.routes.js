const express = require('express');

const authenticate = require('../../middleware/auth.middleware');
const authorize = require('../../middleware/authorize.middleware');
const validate = require('../../middleware/validate.middleware');
const categoryController = require('./category.controller');
const {
  categoryIdSchema,
  createCategorySchema,
  listCategoriesSchema,
  updateCategorySchema,
} = require('./category.validation');

const router = express.Router();

router.use(authenticate, authorize('admin'));

router
  .route('/')
  .get(validate(listCategoriesSchema), categoryController.listCategories)
  .post(validate(createCategorySchema), categoryController.createCategory);

router
  .route('/:id')
  .get(validate(categoryIdSchema), categoryController.getCategory)
  .patch(validate(updateCategorySchema), categoryController.updateCategory)
  .delete(validate(categoryIdSchema), categoryController.deleteCategory);

module.exports = router;
