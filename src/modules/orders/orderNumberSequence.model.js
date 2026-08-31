const mongoose = require('mongoose');

const DATE_KEY_PATTERN = /^\d{8}$/;

const orderNumberSequenceSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      required: true,
      match: [DATE_KEY_PATTERN, 'Order number sequence date is invalid'],
    },
    sequence: {
      type: Number,
      required: true,
      default: 0,
      min: [0, 'Order number sequence cannot be negative'],
      validate: {
        validator: Number.isSafeInteger,
        message: 'Order number sequence must be a safe whole number',
      },
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

const OrderNumberSequence = mongoose.model(
  'OrderNumberSequence',
  orderNumberSequenceSchema,
);

module.exports = OrderNumberSequence;
