const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const service = require('./order.service');

const respond = (res, data, message, status = 200) => res.status(status).json(new ApiResponse(status, data, message));

module.exports = {
  createOrder: asyncHandler(async (req, res) => respond(res, await service.createOrder(req.validated.body, req.user, req.get('idempotency-key')), 'Order created successfully', 201)),
  listOrders: asyncHandler(async (req, res) => respond(res, await service.listOrders(req.validated.query, req.user), 'Orders retrieved successfully')),
  getOrder: asyncHandler(async (req, res) => respond(res, await service.getOrderById(req.validated.params.id, req.user), 'Order retrieved successfully')),
  acceptWholesalerOrder: asyncHandler(async (req, res) => respond(res, await service.acceptWholesalerOrder(req.validated.params.id, req.user), 'Order forwarded to Admin successfully')),
  adjustWholesalerOrder: asyncHandler(async (req, res) => respond(res, await service.adjustWholesalerOrder(req.validated.params.id, req.validated.body, req.user), 'Order adjusted by Wholesaler successfully')),
  adjustAdminOrder: asyncHandler(async (req, res) => respond(res, await service.adjustAdminOrder(req.validated.params.id, req.validated.body, req.user), 'Order adjusted by Admin successfully')),
  cancelOrder: asyncHandler(async (req, res) => respond(res, await service.cancelOrder(req.validated.params.id, req.user, req.validated.body.reason), 'Order cancelled successfully')),
  confirmAdminOrder: asyncHandler(async (req, res) => respond(res, await service.confirmAdminOrder(req.validated.params.id, req.user), 'Order confirmed successfully')),
};
