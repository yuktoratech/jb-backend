const mongoose = require('mongoose');

const colourSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 120,
      match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    },
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
colourSchema.index({ slug: 1 }, { unique: true, name: 'unique_colour_slug' });

module.exports = mongoose.model('Colour', colourSchema);
