const express = require('express');

const authenticate = require('../../middleware/auth.middleware');
const authorize = require('../../middleware/authorize.middleware');
const validate = require('../../middleware/validate.middleware');
const orderController = require('./order.controller');
const {
  adjustOrderSchema,
  createOrderSchema,
  listOrdersSchema,
  orderIdSchema,
  rejectOrderSchema,
} = require('./order.validation');

const router = express.Router();

router.use(authenticate);

router
  .route('/')
  .get(
    authorize('admin', 'wholesaler', 'retailer'),
    validate(listOrdersSchema),
    orderController.listOrders,
  )
  .post(
    authorize('wholesaler', 'retailer'),
    validate(createOrderSchema),
    orderController.createOrder,
  );

router.post(
  '/:id/wholesaler-confirm',
  authorize('wholesaler'),
  validate(orderIdSchema),
  orderController.confirmWholesalerOrder,
);

router.post(
  '/:id/wholesaler-reject',
  authorize('wholesaler'),
  validate(rejectOrderSchema),
  orderController.rejectWholesalerOrder,
);

router.patch(
  '/:id/wholesaler-adjust',
  authorize('wholesaler'),
  validate(adjustOrderSchema),
  orderController.adjustWholesalerOrder,
);

router.post(
  '/:id/admin-confirm',
  authorize('admin'),
  validate(orderIdSchema),
  orderController.confirmAdminOrder,
);

router.post(
  '/:id/admin-reject',
  authorize('admin'),
  validate(rejectOrderSchema),
  orderController.rejectAdminOrder,
);

router.patch(
  '/:id/admin-adjust',
  authorize('admin'),
  validate(adjustOrderSchema),
  orderController.adjustAdminOrder,
);

router.get(
  '/:id',
  authorize('admin', 'wholesaler', 'retailer'),
  validate(orderIdSchema),
  orderController.getOrder,
);

module.exports = router;
