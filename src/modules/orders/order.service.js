const crypto = require('crypto');
const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const addressService = require('../addresses/address.service');
const inventoryService = require('../inventory/inventory.service');
const { safelyNotifyOrderEvent } = require('../notifications/orderNotification.service');
const ProductVariant = require('../variants/productVariant.model');
const User = require('../users/user.model');
const Order = require('./order.model');
const { generateOrderNumber } = require('./orderNumber.service');
const pricing = require('./orderPricing.service');

const orderPopulation = [
  { path: 'placedBy', select: '_id name role' },
  { path: 'wholesaler', select: '_id name role' },
  { path: 'retailer', select: '_id name role' },
  { path: 'confirmedBy', select: '_id name role' },
  { path: 'history.performedBy', select: '_id name role' },
];
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stableSerialize = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const fingerprint = (payload) => crypto.createHash('sha256').update(stableSerialize(payload)).digest('hex');
const normalizeIdempotencyKey = (value) => {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 128) throw new ApiError(400, 'Idempotency-Key must contain 1 to 128 characters');
  return value.trim();
};

const mapSaveError = (error) => {
  if (error instanceof ApiError) return error;
  if (error?.name === 'VersionError') return new ApiError(409, 'Order changed concurrently; please retry');
  if (error?.code === 11000) return new ApiError(409, 'Order operation already exists');
  if (error?.name === 'ValidationError') return new ApiError(400, 'Order validation failed', Object.values(error.errors).map(({ path, message }) => ({ field: path, message })));
  return error;
};

const loadActor = async (actor) => {
  const account = await User.findOne({ _id: actor._id, status: 'active' }).select('_id role parentWholesaler discountPercent').lean();
  if (!account) throw new ApiError(401, 'Active account not found');
  return account;
};

const accessFilter = (actor, orderId) => {
  const filter = orderId ? { _id: orderId } : {};
  if (actor.role === 'retailer') filter.retailer = actor._id;
  else if (actor.role === 'wholesaler') filter.wholesaler = actor._id;
  else if (actor.role !== 'admin') throw new ApiError(403, 'Order access is forbidden');
  return filter;
};
const getOrderDocument = async (id, actor) => {
  const order = await Order.findOne(accessFilter(actor, id));
  if (!order) throw new ApiError(404, 'Order not found');
  return order;
};
const getOrderById = async (id, actor) => {
  const order = await Order.findOne(accessFilter(actor, id)).populate(orderPopulation).lean();
  if (!order) throw new ApiError(404, 'Order not found');
  return order;
};

const loadFinalizedSkus = async (items) => {
  const ids = items.map(({ skuId }) => skuId);
  const variants = await ProductVariant.find({ _id: { $in: ids }, catalogVersion: 2, status: 'active' })
    .populate('product', '_id name mrpPerPieceMinor status catalogVersion')
    .populate({ path: 'productColour', select: '_id productCode status colour', populate: { path: 'colour', select: '_id name status' } })
    .populate('sizeSetRef', '_id label sizes pieceCount status');
  const byId = new Map(variants.map((variant) => [variant._id.toString(), variant]));
  return items.map((item) => {
    const variant = byId.get(item.skuId);
    if (!variant) throw new ApiError(404, 'One or more active finalized SKUs were not found');
    if (variant.product?.status !== 'active' || variant.productColour?.status !== 'active' || variant.productColour?.colour?.status !== 'active' || variant.sizeSetRef?.status !== 'active') {
      throw new ApiError(409, `Inactive catalog master cannot be assigned for SKU ${variant.sku}`);
    }
    return { variant, quantity: item.setQuantity };
  });
};

const resolveParties = async (actor) => {
  if (actor.role === 'wholesaler') return { sourceRole: 'wholesaler', placedBy: actor._id, wholesaler: actor._id, retailer: null, status: 'PENDING_ADMIN' };
  if (actor.role !== 'retailer' || !actor.parentWholesaler) throw new ApiError(403, 'Only Wholesalers and linked Retailers may create Orders');
  const parent = await User.exists({ _id: actor.parentWholesaler, role: 'wholesaler', status: 'active' });
  if (!parent) throw new ApiError(409, 'Parent Wholesaler is not active');
  return { sourceRole: 'retailer', placedBy: actor._id, wholesaler: actor.parentWholesaler, retailer: actor._id, status: 'PENDING_WHOLESALER' };
};

const createOrder = async (payload, requestActor, rawKey, testHooks = {}) => {
  const hooks = process.env.NODE_ENV === 'test' ? testHooks : {};
  const actor = await loadActor(requestActor);
  const parties = await resolveParties(actor);
  const idempotencyKey = normalizeIdempotencyKey(rawKey);
  const requestFingerprint = idempotencyKey ? fingerprint(payload) : undefined;
  if (idempotencyKey) {
    const existing = await Order.findOne({ placedBy: actor._id, idempotencyKey }).select('+requestFingerprint').lean();
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) throw new ApiError(409, 'Idempotency-Key was used with different Order data');
      return getOrderById(existing._id, actor);
    }
  }
  const deliveryAddress = payload.addressId
    ? await addressService.resolveOwnedSnapshot(payload.addressId, actor._id)
    : payload.deliveryAddress;
  const resolved = await loadFinalizedSkus(payload.items);
  const items = resolved.map(({ variant, quantity }) => pricing.createOrderItemSnapshot({ variant, quantity }));
  const totals = pricing.calculateOrderTotals(items, actor.discountPercent || 0);
  if (payload.deliveryAddress && payload.saveAddress) {
    await addressService.createAddress(payload.deliveryAddress, actor._id);
  }
  const order = new Order({
    _id: new mongoose.Types.ObjectId(), orderNumber: await generateOrderNumber(), ...parties,
    idempotencyKey, requestFingerprint, items, deliveryAddress, ...totals,
    history: [{ type: 'CREATED', performedBy: actor._id, performedByRole: actor.role, previousStatus: null, newStatus: parties.status }],
  });
  if (hooks.beforeOrderSave) await hooks.beforeOrderSave({ order });
  try { await order.save(); } catch (error) {
    if (error?.code === 11000 && idempotencyKey) {
      const concurrent = await Order.findOne({ placedBy: actor._id, idempotencyKey }).select('+requestFingerprint').lean();
      if (concurrent?.requestFingerprint === requestFingerprint) return getOrderById(concurrent._id, actor);
    }
    throw mapSaveError(error);
  }
  if (order.sourceRole === 'retailer') {
    await safelyNotifyOrderEvent({
      eventType: 'RETAILER_ORDER_SUBMITTED',
      order,
      recipientUserIds: [order.wholesaler],
    });
  }
  return getOrderById(order._id, actor);
};

const listOrders = async ({ page, limit, search, status, sourceRole, wholesalerId, retailerId }, requestActor) => {
  const actor = await loadActor(requestActor);
  const filter = accessFilter(actor);
  if (status) filter.status = status;
  if (sourceRole) filter.sourceRole = sourceRole;
  if (actor.role === 'admin' && wholesalerId) filter.wholesaler = wholesalerId;
  if (actor.role === 'admin' && retailerId) filter.retailer = retailerId;
  if (search) {
    const expression = { $regex: escapeRegex(search), $options: 'i' };
    filter.$or = [{ orderNumber: expression }, { 'items.sku': expression }, { 'items.productName': expression }];
  }
  const skip = (page - 1) * limit;
  const [orders, total] = await Promise.all([
    Order.find(filter).populate(orderPopulation).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    Order.countDocuments(filter),
  ]);
  return { orders, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
};

const appendHistory = (order, { type, actor, previousStatus, newStatus, reason, itemChanges = [] }) => {
  order.history.push({ type, performedBy: actor._id, performedByRole: actor.role, previousStatus, newStatus, reason, itemChanges });
};

const adminActionRecipients = (order) => [
  order.wholesaler,
  ...(order.sourceRole === 'retailer' && order.retailer ? [order.retailer] : []),
];

const acceptWholesalerOrder = async (id, requestActor) => {
  const actor = await loadActor(requestActor);
  const order = await getOrderDocument(id, actor);
  if (actor.role !== 'wholesaler' || order.sourceRole !== 'retailer' || order.status !== 'PENDING_WHOLESALER') throw new ApiError(409, 'Only a Retailer Order pending this Wholesaler may be accepted');
  const previousStatus = order.status;
  order.status = 'PENDING_ADMIN';
  appendHistory(order, { type: 'WHOLESALER_ACCEPTED', actor, previousStatus, newStatus: order.status });
  try { await order.save(); } catch (error) { throw mapSaveError(error); }
  await safelyNotifyOrderEvent({
    eventType: 'WHOLESALER_ORDER_FORWARDED',
    order,
    recipientUserIds: [order.retailer],
  });
  return getOrderById(order._id, actor);
};

const cancelOrder = async (id, requestActor, reason) => {
  const actor = await loadActor(requestActor);
  const order = await getOrderDocument(id, actor);
  let type;
  if (actor.role === 'retailer') {
    if (order.sourceRole !== 'retailer' || order.status !== 'PENDING_WHOLESALER') throw new ApiError(409, 'Retailer may cancel only before Wholesaler acceptance');
    type = 'RETAILER_CANCELLED';
  } else if (actor.role === 'wholesaler') {
    const retailerPending = order.sourceRole === 'retailer' && order.status === 'PENDING_WHOLESALER';
    const directPending = order.sourceRole === 'wholesaler' && order.status === 'PENDING_ADMIN';
    if (!retailerPending && !directPending) throw new ApiError(409, 'Wholesaler cannot cancel this Order in its current state');
    type = 'WHOLESALER_CANCELLED';
  } else if (actor.role === 'admin') {
    if (order.status !== 'PENDING_ADMIN') throw new ApiError(409, 'Admin may cancel only an Order pending Admin');
    type = 'ADMIN_CANCELLED';
  } else throw new ApiError(403, 'Order cancellation is forbidden');
  const previousStatus = order.status;
  order.status = 'CANCELLED'; order.cancelledBy = actor.role; order.cancellationReason = reason;
  appendHistory(order, { type, actor, previousStatus, newStatus: 'CANCELLED', reason });
  try { await order.save(); } catch (error) { throw mapSaveError(error); }
  if (actor.role === 'wholesaler' && order.sourceRole === 'retailer') {
    await safelyNotifyOrderEvent({
      eventType: 'WHOLESALER_ORDER_CANCELLED',
      order,
      recipientUserIds: [order.retailer],
    });
  } else if (actor.role === 'admin') {
    await safelyNotifyOrderEvent({
      eventType: 'ADMIN_ORDER_CANCELLED',
      order,
      recipientUserIds: adminActionRecipients(order),
    });
  }
  return getOrderById(order._id, actor);
};

const adjustOrder = async (id, payload, requestActor, stage) => {
  const actor = await loadActor(requestActor);
  const order = await getOrderDocument(id, actor);
  if (stage === 'WHOLESALER') {
    if (actor.role !== 'wholesaler' || order.sourceRole !== 'retailer' || order.status !== 'PENDING_WHOLESALER') throw new ApiError(409, 'Wholesaler may adjust only a Retailer Order pending Wholesaler');
  } else if (actor.role !== 'admin' || order.status !== 'PENDING_ADMIN') throw new ApiError(409, 'Admin may adjust only an Order pending Admin');

  const byId = new Map(order.items.map((item) => [item._id.toString(), item]));
  const changes = payload.items.map(({ orderItemId, setQuantity }) => {
    const item = byId.get(orderItemId);
    if (!item) throw new ApiError(400, 'Adjustments may reference only existing Order items; adding products is forbidden');
    if (item.currentSetQty === setQuantity) throw new ApiError(400, 'Adjustment must change the Set quantity');
    return { item, setQuantity };
  });
  const remaining = order.items.filter((item) => {
    const change = changes.find(({ item: changed }) => changed._id.equals(item._id));
    return (change ? change.setQuantity : item.currentSetQty) > 0;
  });
  if (!remaining.length) throw new ApiError(400, 'An Order must retain at least one active item');

  const itemChanges = changes.map(({ item, setQuantity }) => {
    const beforeSetQty = item.currentSetQty;
    Object.assign(item, pricing.recalculateOrderItem(item, setQuantity));
    return { orderItemId: item._id, skuId: item.skuId, sku: item.sku, beforeSetQty, afterSetQty: setQuantity };
  });
  Object.assign(order, pricing.calculateOrderTotals(order.items, order.discountPercent));
  appendHistory(order, { type: `${stage}_ADJUSTED`, actor, previousStatus: order.status, newStatus: order.status, itemChanges });
  try { await order.save(); } catch (error) { throw mapSaveError(error); }
  await safelyNotifyOrderEvent({
    eventType: stage === 'WHOLESALER' ? 'WHOLESALER_ORDER_ADJUSTED' : 'ADMIN_ORDER_ADJUSTED',
    order,
    recipientUserIds: stage === 'WHOLESALER' ? [order.retailer] : adminActionRecipients(order),
  });
  return getOrderById(order._id, actor);
};

const confirmAdminOrder = async (id, requestActor, testHooks = {}) => {
  const actor = await loadActor(requestActor);
  if (actor.role !== 'admin') throw new ApiError(403, 'Only Admin may confirm Orders');
  const hooks = process.env.NODE_ENV === 'test' ? testHooks : {};
  const session = await mongoose.startSession();
  let confirmedOrderId;
  let confirmationEvent;

  try {
    await session.withTransaction(async () => {
      const order = await Order.findById(id).session(session);
      if (!order) throw new ApiError(404, 'Order not found');
      if (order.status !== 'PENDING_ADMIN') {
        throw new ApiError(409, `Only a PENDING_ADMIN Order may be confirmed; current status is ${order.status}`);
      }

      const activeItems = order.items.filter(({ isRemoved, currentSetQty }) => !isRemoved && currentSetQty > 0);
      if (!activeItems.length) throw new ApiError(409, 'Order has no active items to confirm');

      for (let index = 0; index < activeItems.length; index += 1) {
        const item = activeItems[index];
        await inventoryService.deductSkuStock({
          sku: item.sku,
          quantity: item.currentSetQty,
          session,
          referenceId: `ORDER:${order._id.toString()}`,
          performedBy: actor._id,
          note: `Stock deducted for confirmed Order ${order.orderNumber}`,
        });
        if (hooks.afterItemDeduction) await hooks.afterItemDeduction({ index, item, order, session });
      }

      const confirmedAt = new Date();
      order.status = 'CONFIRMED';
      order.confirmedBy = actor._id;
      order.confirmedAt = confirmedAt;
      appendHistory(order, {
        type: 'ADMIN_CONFIRMED',
        actor,
        previousStatus: 'PENDING_ADMIN',
        newStatus: 'CONFIRMED',
      });
      if (hooks.beforeOrderSave) await hooks.beforeOrderSave({ order, session });
      await order.save({ session });
      confirmedOrderId = order._id;
      confirmationEvent = {
        eventType: 'ADMIN_ORDER_CONFIRMED',
        order: {
          _id: order._id,
          orderNumber: order.orderNumber,
          status: order.status,
          sourceRole: order.sourceRole,
        },
        recipientUserIds: adminActionRecipients(order),
      };
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.hasErrorLabel?.('TransientTransactionError') || error?.code === 112) {
      throw new ApiError(409, 'Order confirmation conflicted with another stock operation; please retry');
    }
    throw mapSaveError(error);
  } finally {
    await session.endSession();
  }

  await safelyNotifyOrderEvent(confirmationEvent);
  return getOrderById(confirmedOrderId, actor);
};

module.exports = {
  acceptWholesalerOrder,
  adjustAdminOrder: (id, payload, actor) => adjustOrder(id, payload, actor, 'ADMIN'),
  adjustWholesalerOrder: (id, payload, actor) => adjustOrder(id, payload, actor, 'WHOLESALER'),
  cancelOrder,
  confirmAdminOrder,
  confirmWholesalerOrder: acceptWholesalerOrder,
  createOrder,
  getOrderById,
  listOrders,
};
