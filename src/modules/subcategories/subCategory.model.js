const mongoose = require('mongoose');

const subCategorySchema = new mongoose.Schema(
  {
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
      index: true,
    },
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

subCategorySchema.index(
  { category: 1, name: 1 },
  {
    unique: true,
    collation: { locale: 'en', strength: 2 },
    name: 'unique_subcategory_name_per_category',
  },
);
subCategorySchema.index(
  { category: 1, slug: 1 },
  { unique: true, name: 'unique_subcategory_slug_per_category' },
);
subCategorySchema.index(
  { category: 1, status: 1, createdAt: -1 },
  { name: 'subcategories_by_category_status_and_date' },
);

module.exports = mongoose.model('SubCategory', subCategorySchema);
