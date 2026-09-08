const crypto = require('crypto');
const mongoose = require('mongoose');
const { readSheet } = require('read-excel-file/node');
const ApiError = require('../../utils/ApiError');
const { generateSku, normalizeSizeSetToken, normalizeSku } = require('../../utils/sku');
const ProductColour = require('../productColours/productColour.model');
const ProductVariant = require('../variants/productVariant.model');
const SizeSet = require('../sizeSets/sizeSet.model');
const Inventory = require('./inventory.model');
const ImportBatch = require('./importBatch.model');
const { normalizeShelf } = require('./inventory.utils');

const HEADERS = ['SKU', 'TYPE', 'QUANTITY', 'SHELF', 'TO SHELF'];
const TYPES = ['ADD', 'REMOVE', 'TRANSFER'];
const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const header = (v) => blank(v) ? '' : String(v).trim().replace(/\s+/g, ' ').toUpperCase();
const issue = (rowNumber, field, code, message, sku) => ({ rowNumber, field, code, message, sku });
const quantity = (v) => {
  const n = typeof v === 'number' ? v : (/^\d+$/.test(String(v).trim()) ? Number(v) : NaN);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

const parseWorkbook = async (buffer) => {
  let sheet;
  try { sheet = await readSheet(buffer); } catch (_) { throw new ApiError(422, 'Uploaded file is not a valid XLSX workbook'); }
  if (!sheet?.length) return { totalRows: 0, rows: [], errors: [issue(1, 'FILE', 'EMPTY_FILE', 'The worksheet is empty')] };
  const totalRows = sheet.slice(1).filter((row) => !row.every(blank)).length;
  if (totalRows > 10000) return { totalRows, rows: [], errors: [issue(1, 'FILE', 'TOO_MANY_ROWS', 'The worksheet cannot contain more than 10000 rows')] };
  const map = new Map(); const errors = [];
  sheet[0].forEach((value, index) => {
    const key = header(value); if (!key) return;
    if (!HEADERS.includes(key)) errors.push(issue(1, key, 'UNEXPECTED_COLUMN', `Unexpected column: ${key}`));
    else if (map.has(key)) errors.push(issue(1, key, 'DUPLICATE_COLUMN', `Duplicate column: ${key}`));
    else map.set(key, index);
  });
  HEADERS.forEach((key) => { if (!map.has(key)) errors.push(issue(1, key, 'MISSING_COLUMN', `Required column is missing: ${key}`)); });
  if (errors.length) return { totalRows, rows: [], errors };
  if (!totalRows) return { totalRows, rows: [], errors: [issue(1, 'FILE', 'NO_ROWS', 'The worksheet must contain at least one adjustment row')] };
  const rows = [];
  sheet.slice(1).forEach((cells, index) => {
    if (cells.every(blank)) return;
    const rowNumber = index + 2; let sku; let shelf; let toShelf;
    try { sku = normalizeSku(cells[map.get('SKU')]); } catch (_) { errors.push(issue(rowNumber, 'SKU', 'INVALID_SKU', 'A valid SKU is required')); }
    const type = blank(cells[map.get('TYPE')]) ? '' : String(cells[map.get('TYPE')]).trim().toUpperCase();
    if (!TYPES.includes(type)) errors.push(issue(rowNumber, 'TYPE', 'INVALID_TYPE', 'TYPE must be ADD, REMOVE, or TRANSFER', sku));
    const qty = quantity(cells[map.get('QUANTITY')]);
    if (qty === null) errors.push(issue(rowNumber, 'QUANTITY', 'INVALID_QUANTITY', 'QUANTITY must be a positive whole number', sku));
    try { shelf = normalizeShelf(cells[map.get('SHELF')]); } catch (e) { errors.push(issue(rowNumber, 'SHELF', 'INVALID_SHELF', e.message, sku)); }
    if (type === 'TRANSFER') {
      try { toShelf = normalizeShelf(cells[map.get('TO SHELF')]); } catch (_) { errors.push(issue(rowNumber, 'TO SHELF', 'DESTINATION_REQUIRED', 'TO SHELF is required for TRANSFER', sku)); }
      if (shelf && toShelf && shelf === toShelf) errors.push(issue(rowNumber, 'TO SHELF', 'SAME_SHELF', 'Source and destination shelves must be different', sku));
    } else if (!blank(cells[map.get('TO SHELF')])) errors.push(issue(rowNumber, 'TO SHELF', 'UNEXPECTED_DESTINATION', 'TO SHELF is only allowed for TRANSFER', sku));
    rows.push({ rowNumber, sku, type, quantity: qty, shelf, toShelf });
  });
  const operations = new Map();
  rows.filter((row) => row.sku && row.type && row.quantity && row.shelf).forEach((row) => {
    const signature = [row.sku, row.type, row.quantity, row.shelf, row.toShelf || ''].join('\u0000');
    operations.set(signature, [...(operations.get(signature) || []), row]);
  });
  operations.forEach((duplicates) => {
    if (duplicates.length < 2) return;
    duplicates.forEach((row) => errors.push(issue(row.rowNumber, 'ROW', 'DUPLICATE_OPERATION', 'This exact inventory operation appears more than once', row.sku)));
  });
  return { totalRows, rows, errors };
};

const variantQuery = (filter) => ProductVariant.findOne(filter)
  .populate('product', '_id name status catalogVersion')
  .populate({ path: 'productColour', populate: { path: 'colour', select: '_id name status' } })
  .populate('sizeSetRef', '_id label sizes pieceCount status');
const resolvedFields = (row, variant) => ({ ...row, resolution: 'EXISTING_SKU', skuId: variant._id,
  productId: variant.product._id, productColourId: variant.productColour._id, sizeSetId: variant.sizeSetRef._id,
  productName: variant.product.name, productCode: variant.productColour.productCode, colourName: variant.productColour.colour.name,
  sizeSetLabel: variant.sizeSetRef.label, sizes: variant.sizeSetRef.sizes, pieceCount: variant.sizeSetRef.pieceCount });

const resolveMissing = async (row) => {
  const all = await ProductColour.find({ status: 'active' }).populate('product', '_id name status catalogVersion').populate('colour', '_id name status');
  const matches = all.filter((pc) => pc.product?.status === 'active' && pc.colour?.status === 'active' && row.sku.startsWith(`${pc.productCode}_`));
  if (matches.length !== 1) throw new ApiError(422, matches.length ? 'ProductColour resolution is ambiguous' : 'ProductColour could not be resolved');
  const pc = matches[0]; const token = row.sku.slice(pc.productCode.length + 1);
  const sets = (await SizeSet.find({ status: 'active' })).filter((set) => { try { return normalizeSizeSetToken(set.label) === token; } catch (_) { return false; } });
  if (sets.length !== 1) throw new ApiError(422, sets.length ? 'SizeSet resolution is ambiguous' : 'SizeSet could not be resolved from approved master data');
  const set = sets[0];
  if (generateSku(pc.productCode, set.label) !== row.sku) throw new ApiError(422, 'SKU does not match resolved masters');
  if (await ProductVariant.exists({ productColour: pc._id, sizeSetRef: set._id })) throw new ApiError(409, 'This ProductColour and SizeSet already have a different SKU');
  return { ...row, resolution: 'CREATE_SKU', productId: pc.product._id, productColourId: pc._id, sizeSetId: set._id,
    productName: pc.product.name, productCode: pc.productCode, colourName: pc.colour.name, sizeSetLabel: set.label, sizes: set.sizes, pieceCount: set.pieceCount };
};
const resolveRow = async (row) => {
  const variant = await variantQuery({ sku: row.sku });
  if (!variant) return resolveMissing(row);
  if (!variant.product || !variant.productColour?.colour || !variant.sizeSetRef) throw new ApiError(422, 'SKU is not linked to the finalized catalog');
  return resolvedFields(row, variant);
};
const projectedBalances = (inventory) => new Map((inventory?.shelves || []).map(({ shelf, quantity }) => [shelf, quantity]));
const projectAdjustment = (balances, row) => {
  const source = balances.get(row.shelf) || 0;
  if (row.type === 'ADD') {
    const next = source + row.quantity;
    if (!Number.isSafeInteger(next)) return 'Resulting stock quantity is too large';
    balances.set(row.shelf, next);
    return null;
  }
  if (source < row.quantity) return `Insufficient stock on shelf ${row.shelf}. Available: ${source}`;
  const sourceAfter = source - row.quantity;
  if (sourceAfter === 0) balances.delete(row.shelf); else balances.set(row.shelf, sourceAfter);
  if (row.type === 'TRANSFER') {
    const destination = balances.get(row.toShelf) || 0;
    const next = destination + row.quantity;
    if (!Number.isSafeInteger(next)) {
      balances.set(row.shelf, source);
      return 'Resulting stock quantity is too large';
    }
    balances.set(row.toShelf, next);
  }
  return null;
};
const formatBatch = (batch) => ({ id: batch._id, status: batch.status, totalRows: batch.totalRows, validRows: batch.validRows,
  invalidRows: batch.invalidRows, rows: batch.rows, errors: batch.errors, appliedAt: batch.appliedAt });

const previewImport = async (buffer, { performedBy, originalName }) => {
  const parsed = await parseWorkbook(buffer); const errors = [...parsed.errors]; const rows = [];
  const bad = new Set(errors.filter((e) => e.rowNumber >= 2).map((e) => e.rowNumber));
  const projections = new Map();
  if (!errors.some((e) => e.rowNumber === 1)) for (const row of parsed.rows) {
    if (bad.has(row.rowNumber)) continue;
    try {
      let projection = projections.get(row.sku);
      if (!projection) {
        const resolved = await resolveRow(row);
        const inventory = resolved.skuId ? await Inventory.findOne({ variant: resolved.skuId }).lean() : null;
        projection = { resolved, balances: projectedBalances(inventory) };
        projections.set(row.sku, projection);
      }
      const resolved = { ...row, ...projection.resolved, rowNumber: row.rowNumber, type: row.type, quantity: row.quantity, shelf: row.shelf, toShelf: row.toShelf };
      const message = projectAdjustment(projection.balances, row);
      if (message) errors.push(issue(row.rowNumber, 'QUANTITY', 'INSUFFICIENT_STOCK', message, row.sku)); else rows.push(resolved);
    } catch (e) { errors.push(issue(row.rowNumber, 'SKU', 'SKU_RESOLUTION_FAILED', e.message, row.sku)); }
  }
  const fileError = errors.some((e) => e.rowNumber === 1);
  const invalidRows = fileError ? parsed.totalRows : new Set(errors.filter((e) => e.rowNumber >= 2).map((e) => e.rowNumber)).size;
  const batch = await ImportBatch.create({ originalFilename: originalName, fileSha256: crypto.createHash('sha256').update(buffer).digest('hex'), uploadedBy: performedBy,
    status: errors.length ? 'INVALID' : 'VALID', totalRows: parsed.totalRows, validRows: parsed.totalRows - invalidRows, invalidRows, rows, errors });
  return formatBatch(batch);
};

const loadVariant = async (row, session) => {
  let variant = await ProductVariant.findOne({ sku: row.sku }).session(session);
  if (row.resolution === 'EXISTING_SKU') {
    if (!variant || variant._id.toString() !== row.skuId?.toString()) throw new ApiError(409, `Preview is stale for SKU ${row.sku}`);
    return variant;
  }
  if (variant) throw new ApiError(409, `SKU ${row.sku} was created after preview`);
  const pc = await ProductColour.findOne({ _id: row.productColourId, product: row.productId, status: 'active' }).populate('product colour').session(session);
  const set = await SizeSet.findOne({ _id: row.sizeSetId, status: 'active' }).session(session);
  if (!pc || pc.product?.status !== 'active' || pc.colour?.status !== 'active' || !set || generateSku(pc.productCode, set.label) !== row.sku) throw new ApiError(409, `Catalog resolution changed for SKU ${row.sku}`);
  [variant] = await ProductVariant.create([{ catalogVersion: 2, product: row.productId, productColour: row.productColourId, sizeSetRef: row.sizeSetId, sku: row.sku, status: 'active' }], { session });
  await Inventory.create([{ variant: variant._id, sku: variant.sku, shelves: [] }], { session });
  return variant;
};

const applyImport = async (batchId, { performedBy, afterRowApplied } = {}) => {
  const session = await mongoose.startSession(); let result;
  try {
    await session.withTransaction(async () => {
      const batch = await ImportBatch.findById(batchId).session(session);
      if (!batch) throw new ApiError(404, 'Inventory import batch not found');
      if (batch.status === 'APPLIED') throw new ApiError(409, 'Inventory import batch has already been applied');
      if (batch.status !== 'VALID') throw new ApiError(409, 'Only a valid preview batch can be applied');
      const variants = [];
      const variantsBySku = new Map();
      for (const row of batch.rows) {
        let variant = variantsBySku.get(row.sku);
        if (!variant) {
          variant = await loadVariant(row, session);
          variantsBySku.set(row.sku, variant);
        }
        variants.push(variant);
      }
      const applyProjections = new Map();
      for (let i = 0; i < batch.rows.length; i += 1) {
        const row = batch.rows[i];
        let balances = applyProjections.get(row.sku);
        if (!balances) {
          const inventory = await Inventory.findOne({ variant: variants[i]._id }).session(session).lean();
          balances = projectedBalances(inventory);
          applyProjections.set(row.sku, balances);
        }
        const message = projectAdjustment(balances, row);
        if (message) throw new ApiError(409, `Preview is stale for SKU ${batch.rows[i].sku}: ${message}`);
      }
      const service = require('./inventory.service');
      for (let i = 0; i < batch.rows.length; i += 1) {
        const row = batch.rows[i];
        await service.applyAdjustmentInSession({ variant: variants[i], adjustment: row.toObject(), session, performedBy,
          referenceId: `IMPORT:${batch._id}`, operationKey: `IMPORT:${batch._id}:ROW:${row.rowNumber}` });
        if (afterRowApplied) await afterRowApplied({ index: i, row, session });
      }
      batch.status = 'APPLIED'; batch.appliedAt = new Date(); batch.appliedBy = performedBy; await batch.save({ session });
      result = formatBatch(batch);
    });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e?.code === 11000 || e?.errorLabels?.includes('TransientTransactionError')) throw new ApiError(409, 'Import could not be applied because inventory or catalog data changed; preview again');
    throw e;
  } finally { await session.endSession(); }
  return result;
};

module.exports = { applyImport, previewImport };
