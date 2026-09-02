const express = require('express');
const authenticate = require('../../middleware/auth.middleware');
const authorize = require('../../middleware/authorize.middleware');
const validate = require('../../middleware/validate.middleware');
const controller = require('./order.controller');
const validation = require('./order.validation');

const router = express.Router();
router.use(authenticate);
router.route('/')
  .get(authorize('admin', 'wholesaler', 'retailer'), validate(validation.listOrdersSchema), controller.listOrders)
  .post(authorize('wholesaler', 'retailer'), validate(validation.createOrderSchema), controller.createOrder);

router.post('/:id/wholesaler-accept', authorize('wholesaler'), validate(validation.orderIdSchema), controller.acceptWholesalerOrder);
router.post('/:id/wholesaler-confirm', authorize('wholesaler'), validate(validation.orderIdSchema), controller.acceptWholesalerOrder);
router.patch('/:id/wholesaler-adjust', authorize('wholesaler'), validate(validation.adjustOrderSchema), controller.adjustWholesalerOrder);
router.patch('/:id/admin-adjust', authorize('admin'), validate(validation.adjustOrderSchema), controller.adjustAdminOrder);
router.post('/:id/retailer-cancel', authorize('retailer'), validate(validation.cancelOrderSchema), controller.cancelOrder);
router.post('/:id/wholesaler-cancel', authorize('wholesaler'), validate(validation.cancelOrderSchema), controller.cancelOrder);
router.post('/:id/admin-cancel', authorize('admin'), validate(validation.cancelOrderSchema), controller.cancelOrder);
router.post('/:id/admin-confirm', authorize('admin'), validate(validation.orderIdSchema), controller.confirmAdminOrder);
router.get('/:id', authorize('admin', 'wholesaler', 'retailer'), validate(validation.orderIdSchema), controller.getOrder);

module.exports = router;
