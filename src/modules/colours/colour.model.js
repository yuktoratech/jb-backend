const mongoose = require('mongoose');

const colourSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, uppercase: true, maxlength: 100 },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
      index: true,
    },
  },
  { timestamps: true },
);

colourSchema.index(
  { name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 }, name: 'unique_colour_name' },
);

module.exports = mongoose.model('Colour', colourSchema);
