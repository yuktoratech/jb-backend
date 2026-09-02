const express = require('express');
const authenticate = require('../../middleware/auth.middleware');
const authorize = require('../../middleware/authorize.middleware');
const validate = require('../../middleware/validate.middleware');
const controller = require('./productColour.controller');
const validation = require('./productColour.validation');
const uploadProductColourImage = require('./productColourImageUpload.middleware');

const router = express.Router();
router.use(authenticate);
router.route('/').get(validate(validation.listProductColoursSchema), controller.list).post(authorize('admin'), validate(validation.createProductColourSchema), controller.create);
router.post('/:id/images', authorize('admin'), uploadProductColourImage, validate(validation.uploadImageSchema), controller.uploadImage);
router.patch('/:id/images/reorder', authorize('admin'), validate(validation.reorderImagesSchema), controller.reorderImages);
router.delete('/:id/images/:imageId', authorize('admin'), validate(validation.deleteImageSchema), controller.deleteImage);
router.route('/:id').get(validate(validation.productColourIdSchema), controller.get).patch(authorize('admin'), validate(validation.updateProductColourSchema), controller.update).delete(authorize('admin'), validate(validation.productColourIdSchema), controller.deactivate);
module.exports = router;
