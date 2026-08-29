const express = require('express');

const authenticate = require('../../middleware/auth.middleware');
const authorize = require('../../middleware/authorize.middleware');
const validate = require('../../middleware/validate.middleware');
const wholesalerController = require('./wholesaler.controller');
const {
  createWholesalerSchema,
  listWholesalersSchema,
  updateWholesalerSchema,
  updateWholesalerStatusSchema,
  wholesalerIdSchema,
} = require('./wholesaler.validation');

const router = express.Router();

router.use(authenticate, authorize('admin'));

router
  .route('/')
  .get(validate(listWholesalersSchema), wholesalerController.listWholesalers)
  .post(
    validate(createWholesalerSchema),
    wholesalerController.createWholesaler,
  );

router.patch(
  '/:id/status',
  validate(updateWholesalerStatusSchema),
  wholesalerController.updateWholesalerStatus,
);

router
  .route('/:id')
  .get(validate(wholesalerIdSchema), wholesalerController.getWholesaler)
  .patch(
    validate(updateWholesalerSchema),
    wholesalerController.updateWholesaler,
  );

module.exports = router;
