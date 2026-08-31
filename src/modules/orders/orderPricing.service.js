const ApiError = require('../../utils/ApiError');
const {
  calculateDiscountedUnitMinor,
} = require('./orderMoney.utils');

const MONEY_SCALE = 100;

const assertFiniteNumber = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiError(409, `${label} is not valid for order pricing`);
  }
};

const toMinorUnits = (value, label = 'Amount') => {
  assertFiniteNumber(value, label);

  if (value < 0) {
    throw new ApiError(409, `${label} cannot be negative`);
  }

  const minorUnits = Math.round((value + Number.EPSILON) * MONEY_SCALE);

  if (!Number.isSafeInteger(minorUnits)) {
    throw new ApiError(409, `${label} is outside the supported range`);
  }

  return minorUnits;
};

const fromMinorUnits = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(
      409,
      'Calculated order amount is outside the supported range',
    );
  }

  return value / MONEY_SCALE;
};

const assertDiscountPercent = (discountPercent) => {
  assertFiniteNumber(discountPercent, 'Account discount percent');

  if (discountPercent < 0 || discountPercent > 100) {
    throw new ApiError(
      409,
      'Account discount percent must be between 0 and 100',
    );
  }
};

const assertQuantity = (quantity) => {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new ApiError(
      400,
      'Order item quantity must be a positive whole number',
    );
  }
};

const addMinorUnits = (left, right) => {
  const total = left + right;

  if (!Number.isSafeInteger(total) || total < 0) {
    throw new ApiError(
      409,
      'Calculated order amount is outside the supported range',
    );
  }

  return total;
};

const multiplyMinorUnits = (minorUnits, quantity) => {
  const total = minorUnits * quantity;

  if (!Number.isSafeInteger(total) || total < 0) {
    throw new ApiError(
      409,
      'Calculated order amount is outside the supported range',
    );
  }

  return total;
};

const calculateLinePricing = ({ basePrice, discountPercent, quantity }) => {
  assertDiscountPercent(discountPercent);
  assertQuantity(quantity);

  const basePriceMinor = toMinorUnits(basePrice, 'Product MRP');
  let unitPriceMinor;

  try {
    unitPriceMinor = calculateDiscountedUnitMinor(
      basePriceMinor,
      discountPercent,
    );
  } catch (error) {
    throw new ApiError(409, error.message);
  }

  if (!Number.isSafeInteger(unitPriceMinor) || unitPriceMinor < 0) {
    throw new ApiError(409, 'Calculated unit price is outside the supported range');
  }

  const lineSubtotalMinor = multiplyMinorUnits(basePriceMinor, quantity);
  const lineTotalMinor = multiplyMinorUnits(unitPriceMinor, quantity);
  const discountAmountMinor = lineSubtotalMinor - lineTotalMinor;

  return {
    basePrice: fromMinorUnits(basePriceMinor),
    discountPercent,
    unitPrice: fromMinorUnits(unitPriceMinor),
    lineSubtotal: fromMinorUnits(lineSubtotalMinor),
    discountAmount: fromMinorUnits(discountAmountMinor),
    lineTotal: fromMinorUnits(lineTotalMinor),
  };
};

const copyInventoryAllocation = (inventoryAllocation = []) => {
  if (!Array.isArray(inventoryAllocation)) {
    throw new ApiError(500, 'Inventory allocation must be an array');
  }

  return inventoryAllocation.map(({ shelf, quantity }) => ({
    shelf,
    quantity,
  }));
};

const resolveProductSnapshot = (variant, product) => {
  const resolvedProduct = product || variant?.product;

  if (
    !variant?._id ||
    !resolvedProduct ||
    typeof resolvedProduct !== 'object' ||
    !resolvedProduct._id
  ) {
    throw new ApiError(500, 'Variant and product data are required for pricing');
  }

  return resolvedProduct;
};

const createOrderItemSnapshot = ({
  variant,
  product,
  account,
  quantity,
  discountPercent,
  inventoryAllocation = [],
}) => {
  const resolvedProduct = resolveProductSnapshot(variant, product);
  const resolvedDiscountPercent =
    account?.discountPercent ?? discountPercent;
  const pricing = calculateLinePricing({
    basePrice: resolvedProduct.mrp,
    discountPercent: resolvedDiscountPercent,
    quantity,
  });

  return {
    productId: resolvedProduct._id,
    variantId: variant._id,
    sku: variant.sku,
    productName: resolvedProduct.productName,
    productCode: resolvedProduct.productCode,
    productTitle: resolvedProduct.title,
    color: variant.color,
    sizeSet: variant.sizeSet,
    quantity,
    ...pricing,
    inventoryAllocation: copyInventoryAllocation(inventoryAllocation),
  };
};

const toPlainItem = (item) => {
  if (!item || typeof item !== 'object') {
    throw new ApiError(500, 'Order item snapshot is required');
  }

  if (typeof item.toObject === 'function') {
    return item.toObject({
      depopulate: true,
      getters: false,
      virtuals: false,
    });
  }

  return { ...item };
};

const recalculateOrderItem = (
  item,
  quantity,
  inventoryAllocation = item?.inventoryAllocation,
) => {
  const snapshot = toPlainItem(item);
  const pricing = calculateLinePricing({
    basePrice: snapshot.basePrice,
    discountPercent: snapshot.discountPercent,
    quantity,
  });

  return {
    ...snapshot,
    quantity,
    ...pricing,
    inventoryAllocation: copyInventoryAllocation(inventoryAllocation),
  };
};

const calculateOrderTotals = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, 'At least one order item is required');
  }

  let subtotalMinor = 0;
  let discountAmountMinor = 0;
  let totalAmountMinor = 0;
  let totalPieces = 0;

  items.forEach((item) => {
    if (item.isRemoved) {
      if (
        item.quantity !== 0 ||
        toMinorUnits(item.lineSubtotal, 'Line subtotal') !== 0 ||
        toMinorUnits(item.discountAmount, 'Line discount amount') !== 0 ||
        toMinorUnits(item.lineTotal, 'Line total') !== 0
      ) {
        throw new ApiError(409, 'Removed order item pricing is inconsistent');
      }

      return;
    }

    assertQuantity(item.quantity);

    subtotalMinor = addMinorUnits(
      subtotalMinor,
      toMinorUnits(item.lineSubtotal, 'Line subtotal'),
    );
    discountAmountMinor = addMinorUnits(
      discountAmountMinor,
      toMinorUnits(item.discountAmount, 'Line discount amount'),
    );
    totalAmountMinor = addMinorUnits(
      totalAmountMinor,
      toMinorUnits(item.lineTotal, 'Line total'),
    );
    totalPieces += item.quantity;

    if (!Number.isSafeInteger(totalPieces)) {
      throw new ApiError(409, 'Total pieces is outside the supported range');
    }
  });

  if (subtotalMinor - discountAmountMinor !== totalAmountMinor) {
    throw new ApiError(409, 'Order item pricing totals are inconsistent');
  }

  return {
    subtotal: fromMinorUnits(subtotalMinor),
    discountAmount: fromMinorUnits(discountAmountMinor),
    totalAmount: fromMinorUnits(totalAmountMinor),
    totalPieces,
  };
};

const calculateOrderPricing = calculateOrderTotals;

module.exports = {
  calculateLinePricing,
  calculateOrderPricing,
  calculateOrderTotals,
  createOrderItemSnapshot,
  recalculateOrderItem,
};
