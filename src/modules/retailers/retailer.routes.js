const express = require('express');

const authenticate = require('../../middleware/auth.middleware');
const authorize = require('../../middleware/authorize.middleware');
const validate = require('../../middleware/validate.middleware');
const retailerController = require('./retailer.controller');
const {
  createRetailerSchema,
  listRetailersSchema,
  retailerIdSchema,
  updateRetailerSchema,
  updateRetailerStatusSchema,
} = require('./retailer.validation');

const router = express.Router();

router.use(authenticate);

router
  .route('/')
  .get(
    authorize('admin', 'wholesaler'),
    validate(listRetailersSchema),
    retailerController.listRetailers,
  )
  .post(
    authorize('wholesaler'),
    validate(createRetailerSchema),
    retailerController.createRetailer,
  );

router.patch(
  '/:id/status',
  authorize('wholesaler'),
  validate(updateRetailerStatusSchema),
  retailerController.updateRetailerStatus,
);

router
  .route('/:id')
  .get(
    authorize('admin', 'wholesaler'),
    validate(retailerIdSchema),
    retailerController.getRetailer,
  )
  .patch(
    authorize('wholesaler'),
    validate(updateRetailerSchema),
    retailerController.updateRetailer,
  );

module.exports = router;
