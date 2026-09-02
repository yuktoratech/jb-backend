const ApiError = require('../../utils/ApiError');
const { decimalNumberToFraction } = require('./orderMoney.utils');
const { GST_PERCENT } = require('./order.constants');

const safeInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(409, `${label} is outside the supported range`);
  }
  return value;
};

const multiply = (left, right, label) => {
  const result = BigInt(left) * BigInt(right);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new ApiError(409, `${label} is outside the supported range`);
  return Number(result);
};

const add = (left, right, label) => safeInteger(left + right, label);

// Deterministic round-half-up for non-negative rational values.
const roundFraction = (numerator, denominator) => {
  if (denominator <= 0n || numerator < 0n) throw new RangeError('Invalid non-negative fraction');
  const result = (numerator + denominator / 2n) / denominator;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Rounded amount is outside the supported range');
  return Number(result);
};

const percentageOfMinor = (amountMinor, percent) => {
  safeInteger(amountMinor, 'Amount');
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new ApiError(409, 'Discount percent must be between 0 and 100');
  }
  const fraction = decimalNumberToFraction(percent);
  return roundFraction(
    BigInt(amountMinor) * fraction.numerator,
    100n * fraction.denominator,
  );
};

const createOrderItemSnapshot = ({ variant, quantity }) => {
  const product = variant.product;
  const productColour = variant.productColour;
  const sizeSet = variant.sizeSetRef;
  if (!product || !productColour || !productColour.colour || !sizeSet) {
    throw new ApiError(409, `Finalized catalog data is incomplete for SKU ${variant.sku}`);
  }
  safeInteger(product.mrpPerPieceMinor, 'MRP per piece');
  if (!Number.isSafeInteger(sizeSet.pieceCount) || sizeSet.pieceCount <= 0) {
    throw new ApiError(409, `SizeSet piece count is invalid for SKU ${variant.sku}`);
  }
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new ApiError(400, 'Order Set quantity must be a positive whole number');
  }

  const setMrpMinor = multiply(product.mrpPerPieceMinor, sizeSet.pieceCount, 'Set MRP');
  const originalPieceQty = multiply(quantity, sizeSet.pieceCount, 'Original piece quantity');
  const lineGrossMinor = multiply(setMrpMinor, quantity, 'Line gross amount');
  return {
    productId: product._id,
    productColourId: productColour._id,
    skuId: variant._id,
    sku: variant.sku,
    productName: product.name,
    colour: productColour.colour.name,
    sizeSetLabel: sizeSet.label,
    sizes: [...sizeSet.sizes],
    piecesPerSet: sizeSet.pieceCount,
    mrpPerPieceMinor: product.mrpPerPieceMinor,
    setMrpMinor,
    originalSetQty: quantity,
    currentSetQty: quantity,
    originalPieceQty,
    currentPieceQty: originalPieceQty,
    originalLineGrossMinor: lineGrossMinor,
    currentLineGrossMinor: lineGrossMinor,
    isRemoved: false,
  };
};

const recalculateOrderItem = (item, currentSetQty) => {
  if (!Number.isSafeInteger(currentSetQty) || currentSetQty < 0) {
    throw new ApiError(400, 'Order Set quantity must be a non-negative whole number');
  }
  const currentPieceQty = multiply(currentSetQty, item.piecesPerSet, 'Current piece quantity');
  const currentLineGrossMinor = multiply(item.setMrpMinor, currentSetQty, 'Current line gross amount');
  return { currentSetQty, currentPieceQty, currentLineGrossMinor, isRemoved: currentSetQty === 0 };
};

const calculateOrderTotals = (items, discountPercent) => {
  let grossAmountMinor = 0;
  items.forEach((item) => {
    grossAmountMinor = add(grossAmountMinor, item.currentLineGrossMinor, 'Gross amount');
  });
  const discountAmountMinor = percentageOfMinor(grossAmountMinor, discountPercent);
  const taxableAmountMinor = grossAmountMinor - discountAmountMinor;
  const gstAmountMinor = percentageOfMinor(taxableAmountMinor, GST_PERCENT);
  const finalAmountMinor = add(taxableAmountMinor, gstAmountMinor, 'Final amount');
  return {
    grossAmountMinor,
    discountPercent,
    discountAmountMinor,
    taxableAmountMinor,
    gstPercent: GST_PERCENT,
    gstAmountMinor,
    finalAmountMinor,
  };
};

module.exports = {
  calculateOrderTotals,
  createOrderItemSnapshot,
  percentageOfMinor,
  recalculateOrderItem,
  roundFraction,
};
