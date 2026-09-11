const mongoose = require('mongoose');

const nonNegativeInteger = {
  validator: (value) => Number.isSafeInteger(value) && value >= 0,
  message: 'Value must be a non-negative whole number',
};

const importRowSchema = new mongoose.Schema({
  rowNumber: { type: Number, required: true, immutable: true },
  sku: { type: String, required: true, immutable: true },
  type: { type: String, enum: ['ADD', 'REMOVE', 'TRANSFER'], required: true, immutable: true },
  quantity: { type: Number, required: true, min: 1, immutable: true },
  shelf: { type: String, required: true, immutable: true },
  toShelf: { type: String, immutable: true },
  resolution: { type: String, enum: ['EXISTING_SKU', 'CREATE_SKU'], required: true, immutable: true },
  skuId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductVariant', immutable: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, immutable: true },
  productColourId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductColour', required: true, immutable: true },
  sizeSetId: { type: mongoose.Schema.Types.ObjectId, ref: 'SizeSet', required: true, immutable: true },
  createSizeSet: { type: Boolean, default: false, immutable: true },
  productName: { type: String, required: true, immutable: true },
  productCode: { type: String, required: true, immutable: true },
  colourName: { type: String, required: true, immutable: true },
  sizeSetLabel: { type: String, required: true, immutable: true },
  sizes: { type: [String], required: true, immutable: true },
  pieceCount: { type: Number, required: true, min: 1, immutable: true },
}, { _id: false });

const importErrorSchema = new mongoose.Schema({
  rowNumber: { type: Number, required: true, immutable: true },
  field: { type: String, required: true, immutable: true },
  sku: { type: String, immutable: true },
  code: { type: String, required: true, immutable: true },
  message: { type: String, required: true, immutable: true },
}, { _id: false });

const importBatchSchema = new mongoose.Schema({
  originalFilename: { type: String, required: true, trim: true, maxlength: 255, immutable: true },
  fileSha256: { type: String, required: true, match: /^[a-f\d]{64}$/, immutable: true },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  status: { type: String, enum: ['VALID', 'INVALID', 'APPLIED'], required: true },
  totalRows: { type: Number, required: true, min: 0, validate: nonNegativeInteger, immutable: true },
  validRows: { type: Number, required: true, min: 0, validate: nonNegativeInteger, immutable: true },
  invalidRows: { type: Number, required: true, min: 0, validate: nonNegativeInteger, immutable: true },
  rows: { type: [importRowSchema], default: [], immutable: true },
  errors: { type: [importErrorSchema], default: [], immutable: true },
  appliedAt: { type: Date },
  appliedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, {
  timestamps: true,
  optimisticConcurrency: true,
  suppressReservedKeysWarning: true,
});

importBatchSchema.pre('validate', function validateCounts() {
  if (this.validRows + this.invalidRows !== this.totalRows) this.invalidate('validRows', 'Valid and invalid rows must equal total rows');
  if (this.status === 'VALID' && (this.invalidRows !== 0 || this.errors.length !== 0)) this.invalidate('status', 'A valid batch cannot contain errors');
  if (this.status === 'INVALID' && this.errors.length === 0) this.invalidate('status', 'An invalid batch must contain errors');
  if (this.status === 'APPLIED' && (!this.appliedAt || !this.appliedBy)) this.invalidate('appliedAt', 'Applied metadata is required');
});

importBatchSchema.index({ uploadedBy: 1, createdAt: -1 }, { name: 'import_batches_by_uploader_date' });
importBatchSchema.index({ status: 1, createdAt: -1 }, { name: 'import_batches_by_status_date' });
importBatchSchema.index({ fileSha256: 1, uploadedBy: 1, createdAt: -1 }, { name: 'import_batches_by_file_uploader_date' });

module.exports = mongoose.model('ImportBatch', importBatchSchema);
