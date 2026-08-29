const mongoose = require('mongoose');

const ApiError = require('../../utils/ApiError');
const { normalizeSku } = require('../../utils/sku');
const Product = require('../products/product.model');
const ProductVariant = require('../variants/productVariant.model');
const Inventory = require('./inventory.model');
const InventoryTransaction = require('./inventoryTransaction.model');
const {
  normalizeShelf,
  recalculateInventoryTotals,
} = require('./inventory.utils');

const MAX_OPTIMISTIC_RETRIES = 5;
const TRANSACTION_WRITE_RETRIES = 3;
const inventoryLocks = new Map();

const escapeRegex = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const withInventoryLock = async (key, work) => {
  const previous = inventoryLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);

  inventoryLocks.set(key, tail);
  await previous.catch(() => undefined);

  try {
    return await work();
  } finally {
    release();

    if (inventoryLocks.get(key) === tail) {
      inventoryLocks.delete(key);
    }
  }
};

const withInventoryLocks = async (keys, work) => {
  const normalizedKeys = [...new Set(keys)].sort();

  const acquireNext = (index) => {
    if (index >= normalizedKeys.length) {
      return work();
    }

    return withInventoryLock(normalizedKeys[index], () =>
      acquireNext(index + 1),
    );
  };

  return acquireNext(0);
};

const inventoryDefaults = (variant) => ({
  variant: variant._id,
  sku: variant.sku,
  shelves: [],
  availableQuantity: 0,
  reservedQuantity: 0,
  totalQuantity: 0,
  status: 'out_of_stock',
});

const ensureInventoryForVariant = async (variant) => {
  await Inventory.init();

  const existingInventory = await Inventory.findOne({ variant: variant._id });

  if (existingInventory) {
    return existingInventory;
  }

  try {
    return await Inventory.create(inventoryDefaults(variant));
  } catch (error) {
    if (error?.code !== 11000) {
      throw error;
    }

    const concurrentlyCreatedInventory = await Inventory.findOne({
      variant: variant._id,
    });

    if (concurrentlyCreatedInventory) {
      return concurrentlyCreatedInventory;
    }

    throw error;
  }
};

const ensureInventoriesForVariants = async (variants) => {
  if (variants.length === 0) {
    return;
  }

  await Inventory.init();
  const timestamp = new Date();
  await Inventory.bulkWrite(
    variants.map((variant) => ({
      updateOne: {
        filter: { variant: variant._id },
        update: {
          $setOnInsert: {
            ...inventoryDefaults(variant),
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        },
        upsert: true,
      },
    })),
    { ordered: true, timestamps: false },
  );
};

const deleteInventoriesForVariants = async (variantIds) => {
  if (variantIds.length === 0) {
    return;
  }

  await Inventory.deleteMany({ variant: { $in: variantIds } });
};

const syncInventorySku = async (variant) => {
  const inventory = await ensureInventoryForVariant(variant);

  if (inventory.sku !== variant.sku) {
    inventory.sku = variant.sku;
    await inventory.save();
  }

  return inventory;
};

const copyShelves = (shelves) =>
  shelves.map(({ shelf, quantity }) => ({ shelf, quantity }));

const getShelfStock = (inventory, shelf) =>
  inventory.shelves.find((entry) => entry.shelf === shelf);

const addToShelf = (inventory, shelf, quantity) => {
  let shelfStock = getShelfStock(inventory, shelf);

  if (!shelfStock) {
    inventory.shelves.push({ shelf, quantity: 0 });
    shelfStock = getShelfStock(inventory, shelf);
  }

  const nextQuantity = shelfStock.quantity + quantity;

  if (!Number.isSafeInteger(nextQuantity)) {
    throw new ApiError(400, 'Resulting stock quantity is too large');
  }

  shelfStock.quantity = nextQuantity;
};

const removeFromShelf = (inventory, shelf, quantity) => {
  const shelfStock = getShelfStock(inventory, shelf);

  if (!shelfStock) {
    throw new ApiError(409, `Source shelf ${shelf} has no stock for this SKU`);
  }

  if (shelfStock.quantity < quantity) {
    throw new ApiError(
      409,
      `Insufficient stock on shelf ${shelf}. Available: ${shelfStock.quantity}`,
    );
  }

  shelfStock.quantity -= quantity;

  if (shelfStock.quantity === 0) {
    inventory.shelves = inventory.shelves.filter(
      (entry) => entry.shelf !== shelf,
    );
  }
};

const applyStockChange = (inventory, adjustment) => {
  const { type, quantity, shelf, toShelf } = adjustment;

  if (type === 'ADD') {
    addToShelf(inventory, shelf, quantity);
  } else if (type === 'REMOVE') {
    removeFromShelf(inventory, shelf, quantity);
  } else if (type === 'TRANSFER') {
    if (shelf === toShelf) {
      throw new ApiError(
        400,
        'Source and destination shelves must be different',
      );
    }

    removeFromShelf(inventory, shelf, quantity);
    addToShelf(inventory, toShelf, quantity);
  } else {
    throw new ApiError(400, 'Adjustment type must be ADD, REMOVE, or TRANSFER');
  }

  try {
    recalculateInventoryTotals(inventory);
  } catch (error) {
    throw new ApiError(409, error.message);
  }
};

const createTransactionWithRetry = async (payload) => {
  const transactionPayload = {
    ...payload,
    _id: payload._id || new mongoose.Types.ObjectId(),
  };
  let lastError;

  for (let attempt = 1; attempt <= TRANSACTION_WRITE_RETRIES; attempt += 1) {
    try {
      return await InventoryTransaction.create(transactionPayload);
    } catch (error) {
      lastError = error;

      const existingTransaction = await InventoryTransaction.findById(
        transactionPayload._id,
      ).catch(() => null);

      if (existingTransaction) {
        return existingTransaction;
      }
    }
  }

  throw lastError;
};

const restoreInventorySnapshot = async (inventory, snapshot) => {
  const result = await Inventory.updateOne(
    { _id: inventory._id, __v: inventory.__v },
    {
      $set: {
        shelves: snapshot.shelves,
        availableQuantity: snapshot.availableQuantity,
        reservedQuantity: snapshot.reservedQuantity,
        totalQuantity: snapshot.totalQuantity,
        status: snapshot.status,
      },
      $inc: { __v: 1 },
    },
    { runValidators: true },
  );

  return result.modifiedCount === 1;
};

const formatInventoryDocument = (inventory) => ({
  inventoryId: inventory._id,
  variantId: inventory.variant,
  sku: inventory.sku,
  availableQuantity: inventory.availableQuantity,
  reservedQuantity: inventory.reservedQuantity,
  totalQuantity: inventory.totalQuantity,
  shelves: copyShelves(inventory.shelves),
  status: inventory.status,
  createdAt: inventory.createdAt,
  updatedAt: inventory.updatedAt,
});

const performAdjustmentUnlocked = async ({
  variant,
  adjustment,
  source,
  performedBy,
  referenceId,
  note,
}) => {
  let inventory = await ensureInventoryForVariant(variant);

  for (let attempt = 1; attempt <= MAX_OPTIMISTIC_RETRIES; attempt += 1) {
    if (attempt > 1) {
      inventory = await Inventory.findOne({ variant: variant._id });

      if (!inventory) {
        throw new ApiError(500, 'Inventory record could not be initialized');
      }
    }

    if (inventory.sku !== adjustment.sku) {
      throw new ApiError(
        409,
        'Inventory SKU synchronization is in progress; please retry',
      );
    }

    const snapshot = {
      shelves: copyShelves(inventory.shelves),
      availableQuantity: inventory.availableQuantity,
      reservedQuantity: inventory.reservedQuantity,
      totalQuantity: inventory.totalQuantity,
      status: inventory.status,
    };
    const previousQuantity = inventory.availableQuantity;

    applyStockChange(inventory, adjustment);

    try {
      await inventory.save();
    } catch (error) {
      if (error?.name === 'VersionError' && attempt < MAX_OPTIMISTIC_RETRIES) {
        continue;
      }

      throw error;
    }

    const transactionPayload = {
      inventory: inventory._id,
      variant: variant._id,
      sku: variant.sku,
      type: adjustment.type,
      quantity: adjustment.quantity,
      previousQuantity,
      newQuantity: inventory.availableQuantity,
      source,
    };

    if (adjustment.type === 'ADD') {
      transactionPayload.toShelf = adjustment.shelf;
    } else {
      transactionPayload.fromShelf = adjustment.shelf;
    }

    if (adjustment.type === 'TRANSFER') {
      transactionPayload.toShelf = adjustment.toShelf;
    }

    if (performedBy) {
      transactionPayload.performedBy = performedBy;
    }

    if (referenceId) {
      transactionPayload.referenceId = referenceId;
    }

    if (note) {
      transactionPayload.note = note;
    }

    let transaction;

    try {
      transaction = await createTransactionWithRetry(transactionPayload);
    } catch (error) {
      const restored = await restoreInventorySnapshot(inventory, snapshot).catch(
        () => false,
      );

      if (!restored) {
        console.error(
          `CRITICAL: inventory ${inventory._id.toString()} changed but its transaction history could not be written`,
        );
      }

      throw new ApiError(
        500,
        restored
          ? 'Inventory adjustment failed and stock was restored'
          : 'Inventory adjustment needs administrator review',
      );
    }

    return {
      inventory: formatInventoryDocument(inventory),
      transaction,
    };
  }

  throw new ApiError(409, 'Inventory was updated concurrently; please retry');
};

const normalizeAdjustment = (payload) => {
  if (!payload || typeof payload !== 'object') {
    throw new ApiError(400, 'Inventory adjustment payload is required');
  }

  if (typeof payload.type !== 'string') {
    throw new ApiError(400, 'Adjustment type is required');
  }

  const type = payload.type.trim().toUpperCase();
  let shelf;
  let toShelf;
  let sku;

  try {
    shelf = normalizeShelf(payload.shelf);
    toShelf =
      payload.toShelf === undefined
        ? undefined
        : normalizeShelf(payload.toShelf);
  } catch (error) {
    throw new ApiError(400, error.message);
  }

  try {
    sku = normalizeSku(payload.sku);
  } catch (error) {
    throw new ApiError(400, error.message);
  }

  if (!Number.isSafeInteger(payload.quantity) || payload.quantity <= 0) {
    throw new ApiError(400, 'Quantity must be a positive whole number');
  }

  if (!['ADD', 'REMOVE', 'TRANSFER'].includes(type)) {
    throw new ApiError(400, 'Adjustment type must be ADD, REMOVE, or TRANSFER');
  }

  if (type === 'TRANSFER' && !toShelf) {
    throw new ApiError(400, 'Destination shelf is required for a transfer');
  }

  if (type !== 'TRANSFER' && toShelf) {
    throw new ApiError(400, 'Destination shelf is only allowed for a transfer');
  }

  if (type === 'TRANSFER' && shelf === toShelf) {
    throw new ApiError(
      400,
      'Source and destination shelves must be different',
    );
  }

  return {
    sku,
    type,
    quantity: payload.quantity,
    shelf,
    toShelf,
  };
};

const adjustInventory = async (payload, context = {}) => {
  const adjustment = normalizeAdjustment(payload);

  return withInventoryLocks([adjustment.sku], async () => {
    const variant = await ProductVariant.findOne({ sku: adjustment.sku });

    if (!variant) {
      throw new ApiError(404, 'SKU not found');
    }

    return performAdjustmentUnlocked({
      variant,
      adjustment,
      source: context.source || 'admin',
      performedBy: context.performedBy,
      referenceId: context.referenceId || payload.referenceId,
      note: payload.note,
    });
  });
};

const simulateAdjustment = (simulatedInventory, adjustment) => {
  const { shelves } = simulatedInventory;
  const sourceQuantity = shelves.get(adjustment.shelf) || 0;

  if (adjustment.type === 'ADD') {
    const nextQuantity = sourceQuantity + adjustment.quantity;
    const nextTotal =
      simulatedInventory.totalQuantity + adjustment.quantity;

    if (
      !Number.isSafeInteger(nextQuantity) ||
      !Number.isSafeInteger(nextTotal)
    ) {
      return 'Resulting stock quantity is too large';
    }

    shelves.set(adjustment.shelf, nextQuantity);
    simulatedInventory.totalQuantity = nextTotal;
    return null;
  }

  if (sourceQuantity < adjustment.quantity) {
    return `Insufficient stock on shelf ${adjustment.shelf}. Available: ${sourceQuantity}`;
  }

  if (
    adjustment.type === 'REMOVE' &&
    simulatedInventory.totalQuantity - adjustment.quantity <
      simulatedInventory.reservedQuantity
  ) {
    return 'Stock reserved for future order processing cannot be removed';
  }

  if (adjustment.type === 'TRANSFER') {
    const destinationQuantity = shelves.get(adjustment.toShelf) || 0;
    const nextQuantity = destinationQuantity + adjustment.quantity;

    if (!Number.isSafeInteger(nextQuantity)) {
      return 'Resulting stock quantity is too large';
    }

    shelves.set(
      adjustment.shelf,
      sourceQuantity - adjustment.quantity,
    );
    shelves.set(adjustment.toShelf, nextQuantity);
    return null;
  }

  shelves.set(adjustment.shelf, sourceQuantity - adjustment.quantity);
  simulatedInventory.totalQuantity -= adjustment.quantity;

  return null;
};

const validateAdjustmentBatch = async (adjustments) => {
  const skus = [...new Set(adjustments.map(({ sku }) => sku))];
  const variants = await ProductVariant.find({ sku: { $in: skus } });
  const variantsBySku = new Map(
    variants.map((variant) => [variant.sku, variant]),
  );
  const inventories = await Inventory.find({
    variant: { $in: variants.map(({ _id }) => _id) },
  }).lean();
  const inventoryByVariant = new Map(
    inventories.map((inventory) => [inventory.variant.toString(), inventory]),
  );
  const simulatedInventories = new Map();
  const errors = [];

  variants.forEach((variant) => {
    const inventory = inventoryByVariant.get(variant._id.toString());
    const shelves = new Map(
      (inventory?.shelves || []).map(({ shelf, quantity }) => [
        shelf,
        quantity,
      ]),
    );

    simulatedInventories.set(
      variant.sku,
      {
        shelves,
        totalQuantity: [...shelves.values()].reduce(
          (total, quantity) => total + quantity,
          0,
        ),
        reservedQuantity: inventory?.reservedQuantity || 0,
      },
    );
  });

  adjustments.forEach((adjustment) => {
    if (!variantsBySku.has(adjustment.sku)) {
      errors.push({
        row: adjustment.row,
        sku: adjustment.sku,
        field: 'SKU',
        message: 'SKU not found',
      });
      return;
    }

    const variant = variantsBySku.get(adjustment.sku);
    const inventory = inventoryByVariant.get(variant._id.toString());

    if (inventory && inventory.sku !== adjustment.sku) {
      errors.push({
        row: adjustment.row,
        sku: adjustment.sku,
        field: 'SKU',
        message: 'Inventory SKU synchronization is in progress; retry import',
      });
      return;
    }

    const stockError = simulateAdjustment(
      simulatedInventories.get(adjustment.sku),
      adjustment,
    );

    if (stockError) {
      errors.push({
        row: adjustment.row,
        sku: adjustment.sku,
        field: 'QTY',
        message: stockError,
      });
    }
  });

  return { errors, variantsBySku };
};

const reverseAdjustment = (adjustment) => {
  if (adjustment.type === 'ADD') {
    return { ...adjustment, type: 'REMOVE' };
  }

  if (adjustment.type === 'REMOVE') {
    return { ...adjustment, type: 'ADD' };
  }

  return {
    ...adjustment,
    shelf: adjustment.toShelf,
    toShelf: adjustment.shelf,
  };
};

const applyAdjustmentBatch = async (
  adjustments,
  { performedBy, referenceId },
) =>
  withInventoryLocks(
    adjustments.map(({ sku }) => sku),
    async () => {
      const validation = await validateAdjustmentBatch(adjustments);

      if (validation.errors.length > 0) {
        return { errors: validation.errors };
      }

      const applied = [];

      try {
        for (const adjustment of adjustments) {
          const result = await performAdjustmentUnlocked({
            variant: validation.variantsBySku.get(adjustment.sku),
            adjustment,
            source: 'import',
            performedBy,
            referenceId,
          });

          applied.push({ adjustment, result });
        }
      } catch (error) {
        if (applied.length === 0) {
          throw error;
        }

        const failedRollbacks = [];

        for (const appliedAdjustment of [...applied].reverse()) {
          try {
            await performAdjustmentUnlocked({
              variant: validation.variantsBySku.get(
                appliedAdjustment.adjustment.sku,
              ),
              adjustment: reverseAdjustment(appliedAdjustment.adjustment),
              source: 'system',
              performedBy,
              referenceId: `${referenceId}-ROLLBACK`,
              note: 'Automatic rollback after failed inventory import',
            });
          } catch (rollbackError) {
            failedRollbacks.push(appliedAdjustment.adjustment.sku);
          }
        }

        const rollbackSucceeded = failedRollbacks.length === 0;

        if (!rollbackSucceeded) {
          console.error(
            `CRITICAL: inventory import ${referenceId} could not roll back ${failedRollbacks.length} adjustment(s)`,
          );
        }

        throw new ApiError(
          500,
          rollbackSucceeded
            ? 'Inventory import failed and applied changes were rolled back'
            : 'Inventory import needs administrator review',
        );
      }

      return { errors: [], applied };
    },
  );

const buildInventoryProjection = () => ({
  _id: 0,
  inventoryId: { $ifNull: ['$inventory._id', null] },
  variantId: '$_id',
  productId: '$product._id',
  categoryId: '$product.category',
  sku: 1,
  productName: '$product.productName',
  productCode: '$product.productCode',
  color: 1,
  sizeSet: 1,
  variantStatus: '$status',
  totalQuantity: { $ifNull: ['$inventory.totalQuantity', 0] },
  availableQuantity: { $ifNull: ['$inventory.availableQuantity', 0] },
  reservedQuantity: { $ifNull: ['$inventory.reservedQuantity', 0] },
  shelves: { $ifNull: ['$inventory.shelves', []] },
  status: { $ifNull: ['$inventory.status', 'out_of_stock'] },
  updatedAt: { $ifNull: ['$inventory.updatedAt', '$updatedAt'] },
});

const listInventory = async ({
  page,
  limit,
  search,
  sku,
  product,
  category,
  stockStatus,
}) => {
  const variantMatch = {};

  if (sku) {
    variantMatch.sku = normalizeSku(sku);
  }

  if (product) {
    variantMatch.product = new mongoose.Types.ObjectId(product);
  }

  const pipeline = [
    { $match: variantMatch },
    {
      $lookup: {
        from: Product.collection.name,
        localField: 'product',
        foreignField: '_id',
        as: 'product',
      },
    },
    { $unwind: '$product' },
  ];

  if (category) {
    pipeline.push({
      $match: {
        'product.category': new mongoose.Types.ObjectId(category),
      },
    });
  }

  if (search) {
    const expression = {
      $regex: escapeRegex(search),
      $options: 'i',
    };

    pipeline.push({
      $match: {
        $or: [
          { sku: expression },
          { color: expression },
          { sizeSet: expression },
          { 'product.productName': expression },
          { 'product.productCode': expression },
        ],
      },
    });
  }

  pipeline.push(
    {
      $lookup: {
        from: Inventory.collection.name,
        localField: '_id',
        foreignField: 'variant',
        as: 'inventory',
      },
    },
    { $unwind: { path: '$inventory', preserveNullAndEmptyArrays: true } },
  );

  if (stockStatus) {
    pipeline.push({
      $match: {
        $expr: {
          $eq: [
            { $ifNull: ['$inventory.status', 'out_of_stock'] },
            stockStatus,
          ],
        },
      },
    });
  }

  const skip = (page - 1) * limit;
  pipeline.push(
    { $sort: { 'inventory.updatedAt': -1, updatedAt: -1, _id: -1 } },
    {
      $facet: {
        inventory: [
          { $skip: skip },
          { $limit: limit },
          { $project: buildInventoryProjection() },
        ],
        metadata: [{ $count: 'total' }],
      },
    },
  );

  const [result] = await ProductVariant.aggregate(pipeline);
  const total = result.metadata[0]?.total || 0;

  return {
    inventory: result.inventory,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

const getVariantWithProduct = (filter) =>
  ProductVariant.findOne(filter).populate({
    path: 'product',
    select: '_id productName productCode title category status',
    populate: {
      path: 'category',
      select: '_id name slug status',
    },
  });

const formatInventoryDetail = (variant, inventory) => ({
  ...formatInventoryDocument(inventory),
  product: variant.product,
  color: variant.color,
  sizeSet: variant.sizeSet,
  variantStatus: variant.status,
});

const getInventoryByVariantId = async (variantId) => {
  const variant = await getVariantWithProduct({ _id: variantId });

  if (!variant) {
    throw new ApiError(404, 'Product variant not found');
  }

  const inventory = await ensureInventoryForVariant(variant);
  return formatInventoryDetail(variant, inventory);
};

const getInventoryBySku = async (sku) => {
  const normalizedSku = normalizeSku(sku);
  const variant = await getVariantWithProduct({ sku: normalizedSku });

  if (!variant) {
    throw new ApiError(404, 'SKU not found');
  }

  const inventory = await ensureInventoryForVariant(variant);
  return formatInventoryDetail(variant, inventory);
};

const listTransactions = async (variantId, { page, limit, type, source }) => {
  const variantExists = await ProductVariant.exists({ _id: variantId });

  if (!variantExists) {
    throw new ApiError(404, 'Product variant not found');
  }

  const filter = { variant: variantId };

  if (type) {
    filter.type = type;
  }

  if (source) {
    filter.source = source;
  }

  const skip = (page - 1) * limit;
  const [transactions, total] = await Promise.all([
    InventoryTransaction.find(filter)
      .populate('performedBy', '_id name email role')
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    InventoryTransaction.countDocuments(filter),
  ]);

  return {
    transactions,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

const importAdjustments = (...args) => {
  const inventoryImportService = require('./inventoryImport.service');
  return inventoryImportService.importAdjustments(...args);
};

module.exports = {
  adjustInventory,
  applyAdjustmentBatch,
  deleteInventoriesForVariants,
  ensureInventoriesForVariants,
  ensureInventoryForVariant,
  getInventoryBySku,
  getInventoryByVariantId,
  importAdjustments,
  listInventory,
  listTransactions,
  syncInventorySku,
  validateAdjustmentBatch,
};
