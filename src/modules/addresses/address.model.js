const mongoose = require('mongoose');
const { isValidPhone, normalizePhone } = require('../users/account.utils');

const addressSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true,
  },
  name: { type: String, required: true, trim: true, maxlength: 150 },
  phone: {
    type: String,
    required: true,
    set: normalizePhone,
    validate: { validator: isValidPhone, message: 'Delivery phone is invalid' },
  },
  addressLine1: { type: String, required: true, trim: true, maxlength: 255 },
  addressLine2: { type: String, trim: true, default: '', maxlength: 255 },
  city: { type: String, required: true, trim: true, maxlength: 100 },
  state: { type: String, required: true, trim: true, maxlength: 100 },
  postalCode: { type: String, required: true, trim: true, maxlength: 20 },
  isDefault: { type: Boolean, required: true, default: false },
}, { timestamps: true, optimisticConcurrency: true });

addressSchema.index(
  { user: 1, createdAt: -1 },
  { name: 'addresses_by_user_date' },
);
addressSchema.index(
  { user: 1 },
  {
    unique: true,
    name: 'one_default_address_per_user',
    partialFilterExpression: { isDefault: true },
  },
);

module.exports = mongoose.model('Address', addressSchema);
