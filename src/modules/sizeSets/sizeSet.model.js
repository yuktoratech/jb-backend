const mongoose = require('mongoose');
const { normalizeUpperText } = require('../../utils/sku');

const normalizeMember = (value) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;

const sizeSetSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 100, set: (value) => normalizeUpperText(value, 'SizeSet label') },
    sizes: {
      type: [{ type: String, trim: true, maxlength: 50, set: (value) => normalizeUpperText(normalizeMember(value), 'Size') }],
      required: true,
      validate: [
        { validator: (sizes) => sizes.length > 0, message: 'SizeSet must contain at least one size' },
        {
          validator: (sizes) => sizes.every((size) => typeof size === 'string' && size.length > 0),
          message: 'SizeSet sizes cannot be empty',
        },
        {
          validator: (sizes) => new Set(sizes.map((size) => size.toLocaleLowerCase('en'))).size === sizes.length,
          message: 'SizeSet sizes cannot contain duplicates',
        },
      ],
    },
    pieceCount: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isSafeInteger, message: 'Piece count must be a whole number' },
    },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
  },
  { timestamps: true },
);

sizeSetSchema.pre('validate', function derivePieceCount() {
  if (Array.isArray(this.sizes)) this.pieceCount = this.sizes.length;
});

sizeSetSchema.index(
  { label: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 }, name: 'unique_size_set_label' },
);

module.exports = mongoose.model('SizeSet', sizeSetSchema);
