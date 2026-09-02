const express = require('express');
const authenticate = require('../../middleware/auth.middleware');
const authorize = require('../../middleware/authorize.middleware');
const validate = require('../../middleware/validate.middleware');
const controller = require('./address.controller');
const validation = require('./address.validation');

const router = express.Router();
router.use(authenticate, authorize('wholesaler', 'retailer'));
router.route('/')
  .get(controller.list)
  .post(validate(validation.createAddressSchema), controller.create);
router.post('/:id/default', validate(validation.addressIdSchema), controller.makeDefault);
router.route('/:id')
  .get(validate(validation.addressIdSchema), controller.get)
  .patch(validate(validation.updateAddressSchema), controller.update)
  .delete(validate(validation.addressIdSchema), controller.remove);

module.exports = router;
