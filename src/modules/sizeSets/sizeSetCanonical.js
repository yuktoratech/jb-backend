const ApiError = require('../../utils/ApiError');
const { normalizeUpperText } = require('../../utils/sku');

const ALPHA_SEQUENCE = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'];

const simpleError = (message) => new ApiError(400, message);

const parseNumeric = (raw) => {
  const value = normalizeUpperText(String(raw), 'Size');
  let members;
  if (value.includes(',')) {
    members = value.split(',').map((part) => part.trim());
  } else if (/^\d+\s*-\s*\d+$/.test(value)) {
    const [start, end] = value.split('-').map((part) => Number(part.trim()));
    if (start <= 0 || end <= 0 || start > end || (end - start) % 2 !== 0) {
      throw simpleError(`Size ${value} is not a valid numeric size range.`);
    }
    members = [];
    for (let current = start; current <= end; current += 2) members.push(String(current));
  } else members = [value];
  if (!members.length || members.some((member) => !/^\d+$/.test(member) || Number(member) <= 0)) {
    throw simpleError('Use numeric sizes for this category.');
  }
  const numbers = members.map(Number);
  if (new Set(numbers).size !== numbers.length || numbers.some((number, index) => index && number - numbers[index - 1] !== 2)) {
    throw simpleError('Numeric sizes must be unique, ordered, and increase by 2.');
  }
  return numbers.map(String);
};

const parseAlpha = (raw) => {
  const value = normalizeUpperText(String(raw), 'Size').replace(/\s+/g, '');
  let members;
  if (value.includes(',')) members = value.split(',');
  else if (value.includes('-')) {
    const separator = value.indexOf('-');
    const start = value.slice(0, separator); const end = value.slice(separator + 1);
    const startIndex = ALPHA_SEQUENCE.indexOf(start); const endIndex = ALPHA_SEQUENCE.indexOf(end);
    if (startIndex < 0 || endIndex < startIndex) throw simpleError(`Size ${value} is not a valid alpha size range.`);
    members = ALPHA_SEQUENCE.slice(startIndex, endIndex + 1);
  } else members = [value];
  const indexes = members.map((member) => ALPHA_SEQUENCE.indexOf(member));
  if (indexes.some((index) => index < 0)) throw simpleError('Use alpha sizes for this category.');
  if (new Set(members).size !== members.length || indexes.some((index, position) => position && index !== indexes[position - 1] + 1)) {
    throw simpleError('Alpha sizes must be unique and follow the supported order.');
  }
  return members;
};

const canonicalizeSizeSet = (raw, sizeFamily) => {
  if (!['ALPHA', 'NUMERIC'].includes(sizeFamily)) throw simpleError('Configure a size family for this category.');
  const sizes = sizeFamily === 'NUMERIC' ? parseNumeric(raw) : parseAlpha(raw);
  return { label: sizes.length === 1 ? sizes[0] : `${sizes[0]}-${sizes[sizes.length - 1]}`, sizes, pieceCount: sizes.length };
};

const inferSizeFamily = (raw) => {
  const value = normalizeUpperText(String(raw), 'Size').replace(/\s+/g, '');
  return /^\d+(?:(?:-\d+)|(?:,\d+)+)?$/.test(value) ? 'NUMERIC' : 'ALPHA';
};

const sameCanonicalSizes = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);

module.exports = { ALPHA_SEQUENCE, canonicalizeSizeSet, inferSizeFamily, sameCanonicalSizes };
