const express = require('express');
const authenticate = require('../../middleware/auth.middleware');
const authorize = require('../../middleware/authorize.middleware');
const validate = require('../../middleware/validate.middleware');
const controller = require('./subCategory.controller');
const validation = require('./subCategory.validation');

const router = express.Router();
router.use(authenticate);
router.route('/').get(validate(validation.listSubCategoriesSchema), controller.listSubCategories).post(authorize('admin'), validate(validation.createSubCategorySchema), controller.createSubCategory);
router.route('/:id').get(validate(validation.subCategoryIdSchema), controller.getSubCategory).patch(authorize('admin'), validate(validation.updateSubCategorySchema), controller.updateSubCategory).delete(authorize('admin'), validate(validation.subCategoryIdSchema), controller.deactivateSubCategory);

module.exports = router;
