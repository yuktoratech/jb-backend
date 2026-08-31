const mongoose = require('mongoose');
const crypto = require('crypto');

const ApiError = require('../../utils/ApiError');
const inventoryService = require('../inventory/inventory.service');
const ProductVariant = require('../variants/productVariant.model');
const User = require('../users/user.model');
const Order = require('./order.model');
const { generateOrderNumber } = require('./orderNumber.service');
const orderPricing = require('./orderPricing.service');

const orderLocks = new Map();

const escapeRegex = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const withOrderLock = async (orderId, work) => {
  const lockKey = orderId.toString();
  const previous = orderLocks.get(lockKey) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);

  orderLocks.set(lockKey, tail);
  await previous.catch(() => undefined);

  try {
    return await work();
  } finally {
    release();

    if (orderLocks.get(lockKey) === tail) {
      orderLocks.delete(lockKey);
    }
  }
};

const mapOrderError = (error) => {
  if (error instanceof ApiError) {
    return error;
  }

  if (error?.code === 11000) {
    const keyPattern = error.keyPattern || error.errorResponse?.keyPattern || {};

    if (keyPattern.idempotencyKey) {
      const conflict = new ApiError(409, 'Idempotency key is already in use');
      conflict.code = 'ORDER_IDEMPOTENCY_CONFLICT';
      return conflict;
    }

    return new ApiError(409, 'Order number conflict; please retry');
  }

  if (error?.name === 'VersionError') {
    return new ApiError(409, 'Order changed concurrently; please retry');
  }

  if (error?.name === 'ValidationError') {
    return new ApiError(
      400,
      'Validation failed',
      Object.values(error.errors).map((validationError) => ({
        field: validationError.path,
        message: validationError.message,
      })),
    );
  }

  return error;
};

const saveOrder = async (order) => {
  try {
    return await order.save();
  } catch (error) {
    throw mapOrderError(error);
  }
};

const orderPopulation = [
  { path: 'placedBy', select: '_id name role' },
  { path: 'wholesaler', select: '_id name role' },
  { path: 'retailer', select: '_id name role' },
  { path: 'history.performedBy', select: '_id name role' },
];

const formatOrder = (order) => {
  const source = order?.toObject ? order.toObject() : order;

  if (!source) {
    return null;
  }

  const {
    __v,
    idempotencyKey,
    requestFingerprint,
    ...safeOrder
  } = source;
  safeOrder.items = safeOrder.items.map((item) => {
    const { inventoryAllocation, ...safeItem } = item;
    return safeItem;
  });

  return safeOrder;
};

const buildAccessFilter = (actor, orderId) => {
  const filter = {};

  if (orderId) {
    filter._id = orderId;
  }

  if (actor.role === 'wholesaler') {
    filter.wholesaler = actor._id;
  } else if (actor.role === 'retailer') {
    filter.retailer = actor._id;
  } else if (actor.role !== 'admin') {
    throw new ApiError(403, 'You do not have permission to access orders');
  }

  return filter;
};

const findOrderForActor = async (orderId, actor) => {
  const order = await Order.findOne(buildAccessFilter(actor, orderId));

  if (!order) {
    throw new ApiError(404, 'Order not found');
  }

  return order;
};

const getPopulatedOrder = async (orderId, actor) => {
  const order = await Order.findOne(buildAccessFilter(actor, orderId))
    .populate(orderPopulation)
    .lean();

  if (!order) {
    throw new ApiError(404, 'Order not found');
  }

  return formatOrder(order);
};

const resolveOrderParties = async (actor) => {
  if (actor.role === 'wholesaler') {
    return {
      sourceRole: 'wholesaler',
      placedBy: actor._id,
      wholesaler: actor._id,
      retailer: null,
      status: 'PENDING_ADMIN',
    };
  }

  if (actor.role !== 'retailer' || !actor.parentWholesaler) {
    throw new ApiError(
      403,
      'Only Wholesalers and Retailers can place orders',
    );
  }

  const parentWholesaler = await User.findOne({
    _id: actor.parentWholesaler,
    role: 'wholesaler',
    status: 'active',
  })
    .select('_id')
    .lean();

  if (!parentWholesaler) {
    throw new ApiError(409, 'Parent Wholesaler is not active');
  }

  return {
    sourceRole: 'retailer',
    placedBy: actor._id,
    wholesaler: parentWholesaler._id,
    retailer: actor._id,
    status: 'PENDING_WHOLESALER',
  };
};

const loadActiveOrderVariants = async (requestedItems) => {
  const variants = await ProductVariant.find({
    _id: { $in: requestedItems.map(({ variantId }) => variantId) },
  }).populate({
    path: 'product',
    select: '_id productName productCode title mrp status',
  });
  const variantById = new Map(
    variants.map((variant) => [variant._id.toString(), variant]),
  );

  return requestedItems.map(({ variantId, quantity }) => {
    const variant = variantById.get(variantId);

    if (!variant) {
      throw new ApiError(404, 'One or more Product Variants were not found');
    }

    if (variant.status !== 'active') {
      throw new ApiError(409, `Variant ${variant.sku} is inactive`);
    }

    if (!variant.product || variant.product.status !== 'active') {
      throw new ApiError(409, `Product for SKU ${variant.sku} is inactive`);
    }

    return { quantity, variant };
  });
};

const operationReference = (order, action) =>
  `${order._id.toString()}:${action}:${order.history.length}`;

const appendHistory = (
  order,
  { type, actor, previousStatus, newStatus, reason, note, itemChanges = [] },
) => {
  order.history.push({
    type,
    performedBy: actor._id,
    performedByRole: actor.role,
    timestamp: new Date(),
    previousStatus,
    newStatus,
    reason,
    note,
    itemChanges,
  });
};

const normalizeIdempotencyKey = (value) => {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();

  if (
    normalized.length < 8 ||
    normalized.length > 128 ||
    !/^[\x21-\x7e]+$/.test(normalized)
  ) {
    throw new ApiError(
      400,
      'Idempotency-Key must contain 8 to 128 printable non-space characters',
    );
  }

  return normalized;
};

const stableSerialize = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
};

const createRequestFingerprint = (payload) =>
  crypto.createHash('sha256').update(stableSerialize(payload)).digest('hex');

const findIdempotentOrder = async (
  actor,
  idempotencyKey,
  requestFingerprint,
) => {
  if (!idempotencyKey) {
    return null;
  }

  const existingOrder = await Order.findOne({
    placedBy: actor._id,
    idempotencyKey,
  })
    .select('+requestFingerprint')
    .lean();

  if (!existingOrder) {
    return null;
  }

  if (existingOrder.requestFingerprint !== requestFingerprint) {
    throw new ApiError(
      409,
      'Idempotency-Key was already used with a different order request',
    );
  }

  return getPopulatedOrder(existingOrder._id, actor);
};

const createOrder = async (payload, actor, rawIdempotencyKey) => {
  const parties = await resolveOrderParties(actor);
  const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey);
  const requestFingerprint = idempotencyKey
    ? createRequestFingerprint(payload)
    : undefined;
  const existingOrder = await findIdempotentOrder(
    actor,
    idempotencyKey,
    requestFingerprint,
  );

  if (existingOrder) {
    return existingOrder;
  }

  const resolvedItems = await loadActiveOrderVariants(payload.items);
  const pricedItems = resolvedItems.map(({ variant, quantity }) =>
    orderPricing.createOrderItemSnapshot({
      variant,
      product: variant.product,
      quantity,
      discountPercent: actor.discountPercent || 0,
      inventoryAllocation: [],
    }),
  );
  const totals = orderPricing.calculateOrderTotals(pricedItems);

  await Order.init();
  const order = new Order({
    _id: new mongoose.Types.ObjectId(),
    orderNumber: await generateOrderNumber(),
    ...parties,
    idempotencyKey,
    requestFingerprint,
    inventoryStatus: 'RESERVED',
    pricingVersion: 'ACCOUNT_DISCOUNT_V1',
    items: pricedItems,
    deliveryAddress: payload.deliveryAddress,
    notes: payload.notes,
    ...totals,
    history: [
      {
        type: 'CREATED',
        performedBy: actor._id,
        performedByRole: actor.role,
        timestamp: new Date(),
        previousStatus: null,
        newStatus: parties.status,
      },
    ],
  });

  try {
    await inventoryService.reserveOrderStock(
      pricedItems.map((item) => ({
        variantId: item.variantId,
        sku: item.sku,
        quantity: item.quantity,
      })),
      {
        referenceId: operationReference(order, 'CREATE'),
        performedBy: actor._id,
        note: `Stock reserved for order ${order.orderNumber}`,
      },
      async (allocations) => {
        const allocationByVariant = new Map(
          allocations.map(({ variantId, inventoryAllocation }) => [
            variantId.toString(),
            inventoryAllocation,
          ]),
        );

        order.items.forEach((item) => {
          item.inventoryAllocation =
            allocationByVariant.get(item.variantId.toString()) || [];
        });

        await saveOrder(order);
        return order._id;
      },
    );
  } catch (error) {
    if (idempotencyKey) {
      const concurrentOrder = await findIdempotentOrder(
        actor,
        idempotencyKey,
        requestFingerprint,
      );

      if (concurrentOrder) {
        return concurrentOrder;
      }
    }

    throw error;
  }

  return getPopulatedOrder(order._id, actor);
};

const listOrders = async (
  {
    page,
    limit,
    search,
    status,
    sourceRole,
    dateFrom,
    dateTo,
    wholesalerId,
    retailerId,
  },
  actor,
) => {
  const filter = buildAccessFilter(actor);

  if (status) {
    filter.status = status;
  }

  if (sourceRole) {
    filter.sourceRole = sourceRole;
  }

  if (actor.role === 'admin') {
    if (wholesalerId) {
      filter.wholesaler = wholesalerId;
    }

    if (retailerId) {
      filter.retailer = retailerId;
    }
  }

  if (dateFrom || dateTo) {
    filter.createdAt = {};

    if (dateFrom) {
      filter.createdAt.$gte = dateFrom;
    }

    if (dateTo) {
      filter.createdAt.$lte = dateTo;
    }
  }

  if (search) {
    const expression = { $regex: escapeRegex(search), $options: 'i' };
    filter.$or = [
      { orderNumber: expression },
      { 'items.sku': expression },
      { 'items.productName': expression },
      { 'items.productCode': expression },
      { 'deliveryAddress.name': expression },
      { 'deliveryAddress.phone': expression },
    ];
  }

  const skip = (page - 1) * limit;
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .populate(orderPopulation)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Order.countDocuments(filter),
  ]);

  return {
    orders: orders.map(formatOrder),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

const getOrderById = (orderId, actor) => getPopulatedOrder(orderId, actor);

const assertPendingWholesalerOrder = (order) => {
  if (order.sourceRole !== 'retailer') {
    throw new ApiError(409, 'Only Retailer orders require Wholesaler approval');
  }

  if (order.status !== 'PENDING_WHOLESALER') {
    throw new ApiError(409, 'Order is not pending Wholesaler approval');
  }

  if (order.inventoryStatus !== 'RESERVED') {
    throw new ApiError(409, 'Order inventory is not reserved');
  }
};

const assertPendingAdminOrder = (order) => {
  if (order.status !== 'PENDING_ADMIN') {
    throw new ApiError(409, 'Order is not pending Admin approval');
  }

  if (order.inventoryStatus !== 'RESERVED') {
    throw new ApiError(409, 'Order inventory is not reserved');
  }
};

const confirmWholesalerOrder = async (orderId, actor) => {
  await withOrderLock(orderId, async () => {
    const order = await findOrderForActor(orderId, actor);
    assertPendingWholesalerOrder(order);
    const previousStatus = order.status;

    order.status = 'PENDING_ADMIN';
    appendHistory(order, {
      type: 'WHOLESALER_CONFIRMED',
      actor,
      previousStatus,
      newStatus: order.status,
    });
    await saveOrder(order);
  });

  return getPopulatedOrder(orderId, actor);
};

const orderInventoryItems = (order) =>
  order.items
    .filter((item) => !item.isRemoved && item.quantity > 0)
    .map((item) => ({
      variantId: item.variantId,
      sku: item.sku,
      quantity: item.quantity,
      inventoryAllocation: item.inventoryAllocation,
    }));

const rejectOrder = async (orderId, actor, stage, reason) => {
  let idempotent = false;

  await withOrderLock(orderId, async () => {
    const order = await findOrderForActor(orderId, actor);
    const rejectedBy = stage === 'WHOLESALER' ? 'wholesaler' : 'admin';

    if (
      order.status === 'REJECTED' &&
      order.inventoryStatus === 'RELEASED' &&
      order.rejectedBy === rejectedBy
    ) {
      idempotent = true;
      return;
    }

    if (stage === 'WHOLESALER') {
      assertPendingWholesalerOrder(order);
    } else {
      assertPendingAdminOrder(order);
    }

    const previousStatus = order.status;
    const activityType = `${stage}_REJECTED`;

    await inventoryService.releaseOrderStock(
      orderInventoryItems(order),
      {
        referenceId: operationReference(order, activityType),
        performedBy: actor._id,
        note: reason || `${stage} rejected order ${order.orderNumber}`,
      },
      async () => {
        order.status = 'REJECTED';
        order.inventoryStatus = 'RELEASED';
        order.rejectedBy = rejectedBy;
        order.rejectionReason = reason;
        appendHistory(order, {
          type: activityType,
          actor,
          previousStatus,
          newStatus: order.status,
          reason,
        });
        await saveOrder(order);
      },
    );
  });

  return { idempotent, order: await getPopulatedOrder(orderId, actor) };
};

const rejectWholesalerOrder = (orderId, actor, reason) =>
  rejectOrder(orderId, actor, 'WHOLESALER', reason);

const rejectAdminOrder = (orderId, actor, reason) =>
  rejectOrder(orderId, actor, 'ADMIN', reason);

const confirmAdminOrder = async (orderId, actor) => {
  let idempotent = false;

  await withOrderLock(orderId, async () => {
    const order = await findOrderForActor(orderId, actor);

    if (
      order.status === 'CONFIRMED' &&
      order.inventoryStatus === 'DEDUCTED'
    ) {
      idempotent = true;
      return;
    }

    assertPendingAdminOrder(order);
    const previousStatus = order.status;

    await inventoryService.finalizeOrderStock(
      orderInventoryItems(order),
      {
        referenceId: operationReference(order, 'ADMIN_CONFIRMED'),
        performedBy: actor._id,
        note: `Stock finalized for order ${order.orderNumber}`,
      },
      async () => {
        order.status = 'CONFIRMED';
        order.inventoryStatus = 'DEDUCTED';
        appendHistory(order, {
          type: 'ADMIN_CONFIRMED',
          actor,
          previousStatus,
          newStatus: order.status,
        });
        await saveOrder(order);
      },
    );
  });

  return { idempotent, order: await getPopulatedOrder(orderId, actor) };
};

const adjustOrder = async (orderId, payload, actor, stage) => {
  await withOrderLock(orderId, async () => {
    const order = await findOrderForActor(orderId, actor);

    if (stage === 'WHOLESALER') {
      assertPendingWholesalerOrder(order);
    } else {
      assertPendingAdminOrder(order);
    }

    const requestedQuantityByItem = new Map(
      payload.items.map(({ orderItemId, quantity }) => [orderItemId, quantity]),
    );
    const orderItemById = new Map(
      order.items.map((item) => [item._id.toString(), item]),
    );

    payload.items.forEach(({ orderItemId }) => {
      if (!orderItemById.has(orderItemId)) {
        throw new ApiError(404, 'Order item not found');
      }
    });

    const itemChanges = order.items
      .filter((item) => requestedQuantityByItem.has(item._id.toString()))
      .map((item) => ({
        item,
        nextQuantity: requestedQuantityByItem.get(item._id.toString()),
      }))
      .filter(({ item, nextQuantity }) => item.quantity !== nextQuantity);

    if (itemChanges.length === 0) {
      throw new ApiError(400, 'Adjustment does not change any quantities');
    }

    const increasedItems = itemChanges
      .filter(({ item, nextQuantity }) => nextQuantity > item.quantity)
      .map(({ item, nextQuantity }) => ({
        variantId: item.variantId.toString(),
        quantity: nextQuantity - item.quantity,
      }));

    if (increasedItems.length > 0) {
      await loadActiveOrderVariants(increasedItems);
    }

    const remainingItemCount = order.items.filter((item) => {
      const itemId = item._id.toString();
      const nextQuantity = requestedQuantityByItem.has(itemId)
        ? requestedQuantityByItem.get(itemId)
        : item.quantity;
      return nextQuantity > 0;
    }).length;

    if (remainingItemCount === 0) {
      throw new ApiError(400, 'An order must retain at least one item');
    }

    const activityType = `${stage}_ADJUSTED`;
    const inventoryLines = itemChanges.map(({ item, nextQuantity }) => ({
      variantId: item.variantId,
      sku: item.sku,
      currentQuantity: item.quantity,
      nextQuantity,
      inventoryAllocation: item.inventoryAllocation,
    }));

    await inventoryService.reconcileOrderStock(
      inventoryLines,
      {
        referenceId: operationReference(order, activityType),
        performedBy: actor._id,
        note: payload.note || `${stage} adjusted order ${order.orderNumber}`,
      },
      async (allocations) => {
        const allocationByVariant = new Map(
          allocations.map(({ variantId, inventoryAllocation }) => [
            variantId.toString(),
            inventoryAllocation,
          ]),
        );
        const auditChanges = [];

        itemChanges.forEach(({ item, nextQuantity }) => {
          const beforeQuantity = item.quantity;
          const nextAllocation =
            allocationByVariant.get(item.variantId.toString()) || [];

          auditChanges.push({
            orderItemId: item._id,
            variantId: item.variantId,
            sku: item.sku,
            beforeQuantity,
            afterQuantity: nextQuantity,
          });

          if (nextQuantity > 0) {
            const recalculated = orderPricing.recalculateOrderItem(
              item,
              nextQuantity,
              nextAllocation,
            );

            item.quantity = recalculated.quantity;
            item.lineSubtotal = recalculated.lineSubtotal;
            item.discountAmount = recalculated.discountAmount;
            item.lineTotal = recalculated.lineTotal;
            item.inventoryAllocation = nextAllocation;
            item.isRemoved = false;
          } else {
            item.quantity = 0;
            item.lineSubtotal = 0;
            item.discountAmount = 0;
            item.lineTotal = 0;
            item.inventoryAllocation = [];
            item.isRemoved = true;
          }
        });
        order.set(orderPricing.calculateOrderTotals(order.items));
        appendHistory(order, {
          type: activityType,
          actor,
          previousStatus: order.status,
          newStatus: order.status,
          note: payload.note,
          itemChanges: auditChanges,
        });
        await saveOrder(order);
      },
    );
  });

  return getPopulatedOrder(orderId, actor);
};

const adjustWholesalerOrder = (orderId, payload, actor) =>
  adjustOrder(orderId, payload, actor, 'WHOLESALER');

const adjustAdminOrder = (orderId, payload, actor) =>
  adjustOrder(orderId, payload, actor, 'ADMIN');

module.exports = {
  adjustAdminOrder,
  adjustWholesalerOrder,
  confirmAdminOrder,
  confirmWholesalerOrder,
  createOrder,
  getOrderById,
  listOrders,
  rejectAdminOrder,
  rejectWholesalerOrder,
};
