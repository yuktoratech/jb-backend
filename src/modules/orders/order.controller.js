const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const orderService = require('./order.service');

const createOrder = asyncHandler(async (req, res) => {
  const data = await orderService.createOrder(
    req.validated.body,
    req.user,
    req.get('idempotency-key'),
  );
  res
    .status(201)
    .json(new ApiResponse(201, data, 'Order created successfully'));
});

const listOrders = asyncHandler(async (req, res) => {
  const data = await orderService.listOrders(req.validated.query, req.user);
  res
    .status(200)
    .json(new ApiResponse(200, data, 'Orders retrieved successfully'));
});

const getOrder = asyncHandler(async (req, res) => {
  const data = await orderService.getOrderById(
    req.validated.params.id,
    req.user,
  );
  res
    .status(200)
    .json(new ApiResponse(200, data, 'Order retrieved successfully'));
});

const confirmWholesalerOrder = asyncHandler(async (req, res) => {
  const data = await orderService.confirmWholesalerOrder(
    req.validated.params.id,
    req.user,
  );
  res
    .status(200)
    .json(new ApiResponse(200, data, 'Order forwarded to Admin successfully'));
});

const rejectWholesalerOrder = asyncHandler(async (req, res) => {
  const result = await orderService.rejectWholesalerOrder(
    req.validated.params.id,
    req.user,
    req.validated.body.reason,
  );
  const message = result.idempotent
    ? 'Order was already rejected by the Wholesaler'
    : 'Order rejected by Wholesaler successfully';
  res.status(200).json(new ApiResponse(200, result.order, message));
});

const adjustWholesalerOrder = asyncHandler(async (req, res) => {
  const data = await orderService.adjustWholesalerOrder(
    req.validated.params.id,
    req.validated.body,
    req.user,
  );
  res
    .status(200)
    .json(new ApiResponse(200, data, 'Order adjusted by Wholesaler successfully'));
});

const confirmAdminOrder = asyncHandler(async (req, res) => {
  const result = await orderService.confirmAdminOrder(
    req.validated.params.id,
    req.user,
  );
  const message = result.idempotent
    ? 'Order was already confirmed'
    : 'Order confirmed successfully';
  res.status(200).json(new ApiResponse(200, result.order, message));
});

const rejectAdminOrder = asyncHandler(async (req, res) => {
  const result = await orderService.rejectAdminOrder(
    req.validated.params.id,
    req.user,
    req.validated.body.reason,
  );
  const message = result.idempotent
    ? 'Order was already rejected by Admin'
    : 'Order rejected by Admin successfully';
  res.status(200).json(new ApiResponse(200, result.order, message));
});

const adjustAdminOrder = asyncHandler(async (req, res) => {
  const data = await orderService.adjustAdminOrder(
    req.validated.params.id,
    req.validated.body,
    req.user,
  );
  res
    .status(200)
    .json(new ApiResponse(200, data, 'Order adjusted by Admin successfully'));
});

module.exports = {
  adjustAdminOrder,
  adjustWholesalerOrder,
  confirmAdminOrder,
  confirmWholesalerOrder,
  createOrder,
  getOrder,
  listOrders,
  rejectAdminOrder,
  rejectWholesalerOrder,
};
