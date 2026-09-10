const crypto = require('node:crypto');
const readXlsxFile = require('read-excel-file/node').default;
const ApiError = require('../../utils/ApiError');
const { normalizeProductCode, normalizeProductName, normalizeSku, normalizeUpperText } = require('../../utils/sku');
const { FIELDS, MAX_ISSUES, MAX_ROWS } = require('./productImport.constants');

const normalizeHeader = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
const normalizeText = (value) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;
const aliases = new Map(Object.entries(FIELDS).flatMap(([field, definition]) => definition.aliases.map((alias) => [alias, field])));

const parseMoney = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const minor = Math.round(value * 100);
    return value >= 0 && Math.abs(value * 100 - minor) < 1e-7 && Number.isSafeInteger(minor) ? minor : null;
  }
  if (typeof value === 'string' && /^\d+(?:\.\d{1,2})?$/.test(value.trim())) {
    const [whole, fraction = ''] = value.trim().split('.');
    const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    return Number.isSafeInteger(minor) ? minor : null;
  }
  return null;
};

const parseWorkbook = async (buffer) => {
  let sheet;
  try { sheet = await readXlsxFile(buffer); }
  catch (error) { throw new ApiError(400, 'The uploaded XLSX workbook could not be read'); }
  if (Array.isArray(sheet) && sheet[0]?.data) sheet = sheet[0].data;
  if (!Array.isArray(sheet) || !sheet.length) throw new ApiError(400, 'The XLSX workbook is empty');

  const header = sheet[0];
  const indexes = new Map();
  const duplicateHeaders = [];
  const ignoredHeaders = [];
  header.forEach((raw, index) => {
    const normalized = normalizeHeader(raw);
    if (!normalized) return;
    const field = aliases.get(normalized);
    if (!field) { ignoredHeaders.push(String(raw).trim()); return; }
    if (indexes.has(field)) duplicateHeaders.push({ field, label: FIELDS[field].label });
    else indexes.set(field, index);
  });
  const data = sheet.slice(1).filter((row) => row.some((cell) => cell !== null && cell !== undefined && String(cell).trim() !== ''));
  if (data.length > MAX_ROWS) throw new ApiError(413, `Product import cannot exceed ${MAX_ROWS} rows`);

  const errors = [];
  const warnings = [];
  const add = (collection, issue) => { if (collection.length < MAX_ISSUES) collection.push(issue); };
  duplicateHeaders.forEach(({ field, label }) => add(errors, { rowNumber: 1, field, code: 'DUPLICATE_HEADER', message: `${label} appears more than once` }));
  ignoredHeaders.forEach((label) => add(warnings, { rowNumber: 1, field: 'header', code: 'IGNORED_HEADER', message: `Unsupported column ${label} was ignored` }));
  ['patternWash', 'sleeves', 'waist', 'images', 'initialStock', 'shelf'].forEach((field) => {
    if (indexes.has(field)) add(warnings, { rowNumber: 1, field, code: 'IGNORED_LEGACY_COLUMN', message: `${FIELDS[field].label} is ignored by finalized Product import` });
  });

  const rows = data.map((cells, offset) => {
    const rowNumber = offset + 2;
    const get = (field) => indexes.has(field) ? normalizeText(cells[indexes.get(field)]) : undefined;
    const row = {
      rowNumber,
      productNameInput: get('productName'), categoryName: get('category'), subCategoryName: get('subCategory'),
      fitName: get('fit'), fabricName: get('fabric'), description: get('description') || '', colourName: get('colour'),
      productCodeInput: get('productCode'), sizeSetLabel: get('sizeSet'), status: String(get('status') || 'active').toLowerCase(),
      suppliedSkuInput: get('suppliedSku'),
    };
    for (const field of Object.keys(FIELDS).filter((key) => FIELDS[key].required)) {
      const rowKey = { productName: 'productNameInput', category: 'categoryName', subCategory: 'subCategoryName', fit: 'fitName', fabric: 'fabricName', colour: 'colourName', productCode: 'productCodeInput', sizeSet: 'sizeSetLabel', suppliedSku: 'suppliedSkuInput', mrpPerPiece: 'mrpPerPieceInput' }[field] || field;
      const value = field === 'mrpPerPiece' ? get(field) : row[rowKey];
      if (value === undefined || value === null || value === '') add(errors, { rowNumber, field, code: field === 'subCategory' ? 'SUBCATEGORY_REQUIRED' : 'MISSING_REQUIRED_FIELD', message: `${FIELDS[field].label} is required` });
    }
    const rawMrp = get('mrpPerPiece');
    row.mrpPerPieceMinor = parseMoney(rawMrp);
    if (rawMrp !== undefined && rawMrp !== null && rawMrp !== '' && (!row.mrpPerPieceMinor || row.mrpPerPieceMinor < 1)) add(errors, { rowNumber, field: 'mrpPerPiece', code: 'INVALID_MRP', message: 'MRP must be greater than zero.' });
    if (!['active', 'inactive'].includes(row.status)) add(errors, { rowNumber, field: 'status', code: 'INVALID_STATUS', message: 'Status must be active or inactive' });
    if (row.productNameInput) {
      try { row.productName = normalizeProductName(String(row.productNameInput)); }
      catch (error) { add(errors, { rowNumber, field: 'productName', code: 'INVALID_PRODUCT_NAME', message: error.message }); }
    }
    if (row.colourName) row.colourName = normalizeUpperText(String(row.colourName), 'Colour');
    if (row.sizeSetLabel) row.sizeSetLabel = normalizeUpperText(String(row.sizeSetLabel), 'Size');
    if (row.productCodeInput) {
      try { row.productCode = normalizeProductCode(row.productCodeInput); }
      catch (error) { add(errors, { rowNumber, field: 'productCode', code: 'INVALID_PRODUCT_CODE', message: error.message }); }
    }
    if (row.suppliedSkuInput) {
      try { row.suppliedSku = normalizeSku(String(row.suppliedSkuInput)); }
      catch (error) { add(errors, { rowNumber, field: 'sku', code: 'INVALID_SKU', message: error.message }); }
    }
    return row;
  });
  return { rows, errors, warnings, contentHash: crypto.createHash('sha256').update(buffer).digest('hex') };
};

module.exports = { parseWorkbook };
