const decimalNumberToFraction = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError('A non-negative finite decimal number is required');
  }

  const [coefficient, exponentText = '0'] = value
    .toString()
    .toLowerCase()
    .split('e');
  const exponent = Number(exponentText);
  const [whole, fraction = ''] = coefficient.split('.');
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, '');
  let numerator = BigInt(digits || '0');
  let denominator = 10n ** BigInt(fraction.length);

  if (exponent > 0) {
    numerator *= 10n ** BigInt(exponent);
  } else if (exponent < 0) {
    denominator *= 10n ** BigInt(-exponent);
  }

  return { denominator, numerator };
};

const calculateDiscountedUnitMinor = (basePriceMinor, discountPercent) => {
  if (!Number.isSafeInteger(basePriceMinor) || basePriceMinor < 0) {
    throw new RangeError('Base price minor units are outside the supported range');
  }

  const discount = decimalNumberToFraction(discountPercent);
  const percentageDenominator = 100n * discount.denominator;
  const payableNumerator =
    percentageDenominator - discount.numerator;

  if (payableNumerator < 0n) {
    throw new RangeError('Discount percent cannot exceed 100');
  }

  const rawNumerator = BigInt(basePriceMinor) * payableNumerator;
  const rounded =
    (rawNumerator + percentageDenominator / 2n) /
    percentageDenominator;

  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Discounted price is outside the supported range');
  }

  return Number(rounded);
};

module.exports = {
  calculateDiscountedUnitMinor,
  decimalNumberToFraction,
};
