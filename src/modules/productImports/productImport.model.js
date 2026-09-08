const mongoose = require('mongoose');
const { BATCH_TTL_DAYS } = require('./productImport.constants');

const issueSchema = new mongoose.Schema({
  rowNumber: { type: Number, required: true, immutable: true },
  field: { type: String, required: true, immutable: true },
  code: { type: String, required: true, immutable: true },
  message: { type: String, required: true, immutable: true },
}, { _id: false });

const productImportBatchSchema = new mongoose.Schema({
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  status: { type: String, enum: ['VALID', 'INVALID', 'APPLIED'], required: true },
  originalFilename: { type: String, required: true, trim: true, maxlength: 255, immutable: true },
  contentHash: { type: String, required: true, match: /^[a-f\d]{64}$/, immutable: true },
  totalRows: { type: Number, required: true, min: 0, immutable: true },
  validRows: { type: Number, required: true, min: 0, immutable: true },
  invalidRows: { type: Number, required: true, min: 0, immutable: true },
  normalizedRows: { type: [mongoose.Schema.Types.Mixed], default: [], immutable: true },
  errors: { type: [issueSchema], default: [], immutable: true },
  warnings: { type: [issueSchema], default: [], immutable: true },
  expiresAt: { type: Date, required: true, immutable: true },
  appliedAt: { type: Date },
  appliedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  result: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true, optimisticConcurrency: true, suppressReservedKeysWarning: true });

productImportBatchSchema.pre('validate', function validateBatch() {
  if (this.validRows + this.invalidRows !== this.totalRows) this.invalidate('validRows', 'Valid and invalid rows must equal total rows');
  if (this.status === 'VALID' && this.errors.length) this.invalidate('status', 'A valid batch cannot contain errors');
  if (this.status === 'INVALID' && !this.errors.length) this.invalidate('status', 'An invalid batch must contain errors');
  if (this.status === 'APPLIED' && (!this.appliedAt || !this.appliedBy)) this.invalidate('appliedAt', 'Applied metadata is required');
});

productImportBatchSchema.index({ uploadedBy: 1, createdAt: -1 }, { name: 'product_imports_by_uploader_date' });
productImportBatchSchema.index({ status: 1, createdAt: -1 }, { name: 'product_imports_by_status_date' });
productImportBatchSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'expire_product_import_batches' });

productImportBatchSchema.statics.defaultExpiry = () => new Date(Date.now() + BATCH_TTL_DAYS * 86400000);

module.exports = mongoose.model('ProductImportBatch', productImportBatchSchema);
