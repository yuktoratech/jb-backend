const mongoose = require('mongoose');
const { readSheet } = require('read-excel-file/node');

const ApiError = require('../../utils/ApiError');
const { normalizeSku } = require('../../utils/sku');
const {
  normalizeShelf,
} = require('./inventory.utils');

const EXPECTED_HEADERS = [
  'SKU',
  'QTY',
  'SHELF',
  'ADJUSTMENT TYPE',
  'TO SHELF',
];
const MAX_IMPORT_ROWS = 10000;

const isBlankCell = (value) =>
  value === undefined || value === null ||
  (typeof value === 'string' && value.trim() === '');

const normalizeHeader = (value) =>
  isBlankCell(value)
    ? ''
    : String(value).trim().replace(/\s+/g, ' ').toUpperCase();

const buildHeaderMap = (headerRow) => {
  const headerMap = new Map();
  const errors = [];

  headerRow.forEach((value, index) => {
    const header = normalizeHeader(value);

    if (!header) {
      return;
    }

    if (!EXPECTED_HEADERS.includes(header)) {
      errors.push({
        row: 1,
        field: header,
        message: `Unexpected column: ${header}`,
      });
      return;
    }

    if (headerMap.has(header)) {
      errors.push({
        row: 1,
        field: header,
        message: `Duplicate column: ${header}`,
      });
      return;
    }

    headerMap.set(header, index);
  });

  EXPECTED_HEADERS.forEach((header) => {
    if (!headerMap.has(header)) {
      errors.push({
        row: 1,
        field: header,
        message: `Required column is missing: ${header}`,
      });
    }
  });

  return { headerMap, errors };
};

const parsePositiveQuantity = (value) => {
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
  ) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const quantity = Number(value.trim());

    if (Number.isSafeInteger(quantity) && quantity > 0) {
      return quantity;
    }
  }

  return null;
};

const parseRows = (rows, headerMap) => {
  const adjustments = [];
  const errors = [];
  let totalRows = 0;

  rows.slice(1).forEach((row, index) => {
    const rowNumber = index + 2;

    if (row.every(isBlankCell)) {
      return;
    }

    totalRows += 1;
    const rawSku = row[headerMap.get('SKU')];
    const rawQuantity = row[headerMap.get('QTY')];
    const rawShelf = row[headerMap.get('SHELF')];
    const rawType = row[headerMap.get('ADJUSTMENT TYPE')];
    const rawToShelf = row[headerMap.get('TO SHELF')];
    const rowErrors = [];
    let sku;
    let shelf;
    let toShelf;

    try {
      sku = normalizeSku(rawSku);
    } catch (error) {
      rowErrors.push({
        row: rowNumber,
        field: 'SKU',
        message: 'A valid SKU is required',
      });
    }

    const quantity = parsePositiveQuantity(rawQuantity);

    if (quantity === null) {
      rowErrors.push({
        row: rowNumber,
        sku,
        field: 'QTY',
        message: 'Quantity must be a positive whole number',
      });
    }

    try {
      shelf = normalizeShelf(rawShelf);
    } catch (error) {
      rowErrors.push({
        row: rowNumber,
        sku,
        field: 'SHELF',
        message: error.message,
      });
    }

    const type = isBlankCell(rawType)
      ? ''
      : String(rawType).trim().toUpperCase();

    if (!['ADD', 'REMOVE', 'TRANSFER'].includes(type)) {
      rowErrors.push({
        row: rowNumber,
        sku,
        field: 'ADJUSTMENT TYPE',
        message: 'Adjustment type must be ADD, REMOVE, or TRANSFER',
      });
    }

    if (type === 'TRANSFER') {
      try {
        toShelf = normalizeShelf(rawToShelf);
      } catch (error) {
        rowErrors.push({
          row: rowNumber,
          sku,
          field: 'TO SHELF',
          message: 'Destination shelf is required for a transfer',
        });
      }

      if (shelf && toShelf && shelf === toShelf) {
        rowErrors.push({
          row: rowNumber,
          sku,
          field: 'TO SHELF',
          message: 'Source and destination shelves must be different',
        });
      }
    } else if (!isBlankCell(rawToShelf)) {
      rowErrors.push({
        row: rowNumber,
        sku,
        field: 'TO SHELF',
        message: 'Destination shelf is only allowed for a transfer',
      });
    }

    errors.push(...rowErrors);

    if (rowErrors.length === 0) {
      adjustments.push({
        row: rowNumber,
        sku,
        quantity,
        shelf,
        type,
        toShelf,
      });
    }
  });

  return { adjustments, errors, totalRows };
};

const makeValidationResult = (totalRows, errors) => {
  const hasFileLevelError = errors.some(
    ({ row }) => !Number.isInteger(row) || row < 2,
  );
  const invalidRowNumbers = new Set(
    errors
      .map(({ row }) => row)
      .filter((row) => Number.isInteger(row) && row >= 2),
  );
  const invalidRows = hasFileLevelError
    ? totalRows
    : Math.min(totalRows, invalidRowNumbers.size);

  return {
    success: false,
    statusCode: 400,
    message: 'Inventory adjustment file contains validation errors',
    data: {
      totalRows,
      validRows: Math.max(0, totalRows - invalidRows),
      invalidRows,
      errors,
    },
  };
};

const importAdjustments = async (buffer, { performedBy }) => {
  let rows;

  try {
    rows = await readSheet(buffer);
  } catch (error) {
    throw new ApiError(422, 'Uploaded file is not a valid XLSX workbook');
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return makeValidationResult(0, [
      {
        row: 1,
        field: 'FILE',
        message: 'The worksheet is empty',
      },
    ]);
  }

  if (rows.length > MAX_IMPORT_ROWS + 1) {
    return makeValidationResult(rows.length - 1, [
      {
        row: 1,
        field: 'FILE',
        message: `The worksheet cannot contain more than ${MAX_IMPORT_ROWS} rows`,
      },
    ]);
  }

  const { headerMap, errors: headerErrors } = buildHeaderMap(rows[0]);

  if (headerErrors.length > 0) {
    const totalRows = rows
      .slice(1)
      .reduce((total, row) => total + (row.every(isBlankCell) ? 0 : 1), 0);

    return makeValidationResult(totalRows, headerErrors);
  }

  const parsed = parseRows(rows, headerMap);

  if (parsed.totalRows === 0) {
    return makeValidationResult(0, [
      {
        row: 1,
        field: 'FILE',
        message: 'The worksheet must contain at least one adjustment row',
      },
    ]);
  }

  const inventoryService = require('./inventory.service');
  const databaseValidation =
    parsed.adjustments.length > 0
      ? await inventoryService.validateAdjustmentBatch(parsed.adjustments)
      : { errors: [] };
  const errors = [...parsed.errors, ...databaseValidation.errors].sort(
    (left, right) => (left.row || 0) - (right.row || 0),
  );

  if (errors.length > 0) {
    return makeValidationResult(parsed.totalRows, errors);
  }

  const referenceId = `IMPORT-${new mongoose.Types.ObjectId().toString()}`;
  const result = await inventoryService.applyAdjustmentBatch(
    parsed.adjustments,
    { performedBy, referenceId },
  );

  if (result.errors.length > 0) {
    return makeValidationResult(parsed.totalRows, result.errors);
  }

  const counts = parsed.adjustments.reduce(
    (totals, adjustment) => {
      totals[adjustment.type] += 1;
      return totals;
    },
    { ADD: 0, REMOVE: 0, TRANSFER: 0 },
  );

  return {
    success: true,
    statusCode: 200,
    message: 'Inventory adjustments imported successfully',
    data: {
      totalRows: parsed.totalRows,
      processedRows: result.applied.length,
      addCount: counts.ADD,
      removeCount: counts.REMOVE,
      transferCount: counts.TRANSFER,
      referenceId,
    },
  };
};

module.exports = {
  importAdjustments,
};
