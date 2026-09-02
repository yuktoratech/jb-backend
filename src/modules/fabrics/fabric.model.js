const mongoose = require('mongoose');

const fabricSchema = new mongoose.Schema(
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
    status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
  },
  { timestamps: true },
);

fabricSchema.index(
  { name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 }, name: 'unique_fabric_name' },
);
fabricSchema.index({ slug: 1 }, { unique: true, name: 'unique_fabric_slug' });

module.exports = mongoose.model('Fabric', fabricSchema);
