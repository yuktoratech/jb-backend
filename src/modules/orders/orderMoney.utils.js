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

module.exports = {
  decimalNumberToFraction,
};
