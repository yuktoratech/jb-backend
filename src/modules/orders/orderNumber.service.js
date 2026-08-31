const ApiError = require('../../utils/ApiError');
const OrderNumberSequence = require('./orderNumberSequence.model');

const MIN_SEQUENCE_LENGTH = 6;
const MAX_SEQUENCE = 999999999999;

const toUtcDateKey = (value) => {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new ApiError(500, 'Order number date is invalid');
  }

  return date.toISOString().slice(0, 10).replaceAll('-', '');
};

const incrementSequence = (dateKey, allowUpsert) =>
  OrderNumberSequence.findOneAndUpdate(
    { _id: dateKey },
    { $inc: { sequence: 1 } },
    {
      returnDocument: 'after',
      runValidators: true,
      setDefaultsOnInsert: true,
      upsert: allowUpsert,
    },
  ).lean();

const getNextSequence = async (dateKey) => {
  try {
    return await incrementSequence(dateKey, true);
  } catch (error) {
    if (error?.code !== 11000) {
      throw error;
    }

    return incrementSequence(dateKey, false);
  }
};

const generateOrderNumber = async (date = new Date()) => {
  const dateKey = toUtcDateKey(date);
  const counter = await getNextSequence(dateKey);

  if (!counter || !Number.isSafeInteger(counter.sequence)) {
    throw new ApiError(500, 'Order number could not be generated');
  }

  if (counter.sequence > MAX_SEQUENCE) {
    throw new ApiError(503, 'Daily order number capacity has been reached');
  }

  const sequence = String(counter.sequence).padStart(MIN_SEQUENCE_LENGTH, '0');
  return `JB-${dateKey}-${sequence}`;
};

module.exports = {
  generateOrderNumber,
  toUtcDateKey,
};
