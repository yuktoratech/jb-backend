const crypto = require('node:crypto');

const readWorkbook = require('read-excel-file/node').default;

const ApiError = require('../../utils/ApiError');
const { normalizeShelf } = require('../inventory/inventory.utils');
const {
  generateSku,
  normalizeSku,
  normalizeSkuPart,
} = require('../../utils/sku');
const {
  DEFAULT_INITIAL_SHELF,
  FIELD_DEFINITIONS,
  MAX_IMPORT_ROWS,
  MAX_ISSUES,
  PRODUCT_ATTRIBUTE_FIELDS,
  REQUIRED_FIELDS,
} = require('./catalogMigration.constants');

const TEXT_LIMITS = {
  productName: 150,
  sourceProductCode: 100,
  sku: 255,
  category: 100,
  title: 300,
  color: 100,
  sizeSet: 100,
  fit: 200,
  patternWash: 200,
  fabric: 200,
  sleeves: 200,
  waist: 100,
  description: 5000,
  status: 20,
  shelf: 100,
};

const isBlankCell = (value) =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '');

const normalizeHeader = (value) =>
  isBlankCell(value)
    ? ''
    : String(value).trim().replace(/\s+/g, ' ').toUpperCase();

const aliasToField = new Map();

Object.entries(FIELD_DEFINITIONS).forEach(([field, definition]) => {
  definition.aliases.forEach((alias) => aliasToField.set(alias, field));
});

const normalizeDisplayText = (value) => value.trim().replace(/\s+/g, ' ');
const comparisonText = (value) =>
  value === undefined ? undefined : normalizeDisplayText(value).toLowerCase();

const createIssueCollector = () => {
  const issues = [];
  const invalidRows = new Set();
  let count = 0;

  const add = (issue) => {
    count += 1;

    if (Number.isInteger(issue.row) && issue.row >= 2) {
      invalidRows.add(issue.row);
    }

    if (issues.length < MAX_ISSUES) {
      issues.push(issue);
    }
  };

  return {
    add,
    get count() {
      return count;
    },
    invalidRows,
    issues,
    get truncated() {
      return count > issues.length;
    },
  };
};

const inspectHeaders = (sheet) => {
  const headerRow = Array.isArray(sheet?.data?.[0]) ? sheet.data[0] : [];
  const fieldIndexes = new Map();
  const duplicateFields = [];
  const ignoredHeaders = [];

  headerRow.forEach((rawHeader, index) => {
    const header = normalizeHeader(rawHeader);

    if (!header) {
      return;
    }

    const field = aliasToField.get(header);

    if (!field) {
      ignoredHeaders.push(String(rawHeader).trim());
      return;
    }

    if (fieldIndexes.has(field)) {
      duplicateFields.push({
        field,
        header: String(rawHeader).trim(),
      });
      return;
    }

    fieldIndexes.set(field, index);
  });

  return {
    duplicateFields,
    fieldIndexes,
    ignoredHeaders,
    matchedRequiredCount: REQUIRED_FIELDS.filter((field) =>
      fieldIndexes.has(field),
    ).length,
    missingRequiredFields: REQUIRED_FIELDS.filter(
      (field) => !fieldIndexes.has(field),
    ),
  };
};

const selectDataSheet = (sheets) => {
  const inspected = sheets.map((sheet) => ({
    sheet,
    inspection: inspectHeaders(sheet),
  }));
  const eligible = inspected.filter(
    ({ inspection }) => inspection.missingRequiredFields.length === 0,
  );

  if (eligible.length > 0) {
    return {
      selected:
        eligible.find(
          ({ sheet }) => sheet.sheet.toLowerCase() === 'sheet1',
        ) || eligible[0],
      eligibleCount: eligible.length,
      inspected,
    };
  }

  const selected = inspected.sort(
    (left, right) =>
      right.inspection.matchedRequiredCount -
      left.inspection.matchedRequiredCount,
  )[0];

  return { selected, eligibleCount: 0, inspected };
};

const readText = ({ rawValue, field, rowNumber, errors, required = false }) => {
  const definition = FIELD_DEFINITIONS[field];

  if (isBlankCell(rawValue)) {
    if (required) {
      errors.add({
        row: rowNumber,
        column: definition.label,
        field,
        code: 'MISSING_REQUIRED_FIELD',
        message: `${definition.label} is required`,
      });
    }

    return undefined;
  }

  if (typeof rawValue !== 'string') {
    errors.add({
      row: rowNumber,
      column: definition.label,
      field,
      code: 'INVALID_TEXT',
      message: `${definition.label} must be text`,
    });
    return undefined;
  }

  const value = normalizeDisplayText(rawValue);
  const maxLength = TEXT_LIMITS[field];

  if (maxLength && value.length > maxLength) {
    errors.add({
      row: rowNumber,
      column: definition.label,
      field,
      code: 'TEXT_TOO_LONG',
      message: `${definition.label} cannot exceed ${maxLength} characters`,
    });
    return undefined;
  }

  return value;
};

const readMrp = (rawValue, rowNumber, errors) => {
  if (isBlankCell(rawValue)) {
    errors.add({
      row: rowNumber,
      column: 'MRP',
      field: 'mrp',
      code: 'MISSING_REQUIRED_FIELD',
      message: 'MRP is required',
    });
    return undefined;
  }

  const value =
    typeof rawValue === 'number'
      ? rawValue
      : typeof rawValue === 'string' && /^\d+(?:\.\d{1,2})?$/.test(rawValue.trim())
        ? Number(rawValue.trim())
        : Number.NaN;

  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1000000000 ||
    Math.abs(value * 100 - Math.round(value * 100)) > Number.EPSILON * 100
  ) {
    errors.add({
      row: rowNumber,
      column: 'MRP',
      field: 'mrp',
      code: 'INVALID_MRP',
      message: 'MRP must be a non-negative amount with at most two decimals',
    });
    return undefined;
  }

  return Math.round(value * 100) / 100;
};

const readInitialStock = (rawValue, rowNumber, errors) => {
  if (isBlankCell(rawValue)) {
    return { provided: false, quantity: 0 };
  }

  const value =
    typeof rawValue === 'number'
      ? rawValue
      : typeof rawValue === 'string' && /^\d+$/.test(rawValue.trim())
        ? Number(rawValue.trim())
        : Number.NaN;

  if (!Number.isSafeInteger(value) || value < 0) {
    errors.add({
      row: rowNumber,
      column: 'Initial Stock',
      field: 'initialStock',
      code: 'INVALID_INITIAL_STOCK',
      message: 'Initial stock must be a non-negative whole number',
    });
    return { provided: true, quantity: undefined };
  }

  return { provided: true, quantity: value };
};

const readImages = (rawValue, rowNumber, errors) => {
  if (isBlankCell(rawValue)) {
    return [];
  }

  if (typeof rawValue !== 'string') {
    errors.add({
      row: rowNumber,
      column: 'Images',
      field: 'images',
      code: 'INVALID_IMAGES',
      message: 'Images must be text references separated by commas, pipes, or lines',
    });
    return [];
  }

  const images = rawValue
    .split(/[\n|,]+/)
    .map((value) => value.trim())
    .filter(Boolean);

  if (images.length > 50 || images.some((value) => value.length > 2048)) {
    errors.add({
      row: rowNumber,
      column: 'Images',
      field: 'images',
      code: 'INVALID_IMAGES',
      message: 'A product may contain up to 50 image references of 2048 characters each',
    });
    return [];
  }

  return [...new Set(images)];
};

const normalizeRow = ({ rawRow, rowNumber, fieldIndexes, errors, warnings }) => {
  const valueFor = (field) => rawRow[fieldIndexes.get(field)];
  const row = { rowNumber };

  [
    'productName',
    'sourceProductCode',
    'sku',
    'category',
    'title',
    'color',
    'sizeSet',
  ].forEach((field) => {
    row[field] = readText({
      rawValue: valueFor(field),
      field,
      rowNumber,
      errors,
      required: true,
    });
  });

  PRODUCT_ATTRIBUTE_FIELDS.forEach((field) => {
    row[field] = readText({
      rawValue: valueFor(field),
      field,
      rowNumber,
      errors,
    });
  });

  row.description = readText({
    rawValue: valueFor('description'),
    field: 'description',
    rowNumber,
    errors,
  });
  row.mrp = readMrp(valueFor('mrp'), rowNumber, errors);
  row.images = readImages(valueFor('images'), rowNumber, errors);
  const stock = readInitialStock(valueFor('initialStock'), rowNumber, errors);
  row.initialStockProvided = stock.provided;
  row.initialStock = stock.quantity;

  const rawStatus = readText({
    rawValue: valueFor('status'),
    field: 'status',
    rowNumber,
    errors,
  });
  row.status = rawStatus ? rawStatus.toLowerCase() : 'active';

  if (!['active', 'inactive'].includes(row.status)) {
    errors.add({
      row: rowNumber,
      column: 'Status',
      field: 'status',
      code: 'INVALID_STATUS',
      message: 'Status must be active or inactive',
    });
  }

  const rawShelf = readText({
    rawValue: valueFor('shelf'),
    field: 'shelf',
    rowNumber,
    errors,
  });

  if (rawShelf) {
    try {
      row.shelf = normalizeShelf(rawShelf);
    } catch (error) {
      errors.add({
        row: rowNumber,
        column: 'Shelf',
        field: 'shelf',
        code: 'INVALID_SHELF',
        message: error.message,
      });
    }
  } else if (row.initialStock > 0) {
    row.shelf = DEFAULT_INITIAL_SHELF;
    warnings.add({
      row: rowNumber,
      column: 'Shelf',
      code: 'DEFAULT_INITIAL_SHELF',
      message: `Opening stock will use the default shelf ${DEFAULT_INITIAL_SHELF}`,
    });
  }

  if (row.shelf && !row.initialStock) {
    warnings.add({
      row: rowNumber,
      column: 'Shelf',
      code: 'UNUSED_SHELF',
      message: 'Shelf is ignored because no positive initial stock is supplied',
    });
  }

  const invalidBeforeNormalization = errors.invalidRows.has(rowNumber);

  if (invalidBeforeNormalization) {
    return row;
  }

  try {
    row.productCode = normalizeSkuPart(row.productName, 'Product name');
  } catch (error) {
    errors.add({
      row: rowNumber,
      column: 'Product Name',
      field: 'productName',
      code: 'INVALID_PRODUCT_NAME',
      message: error.message,
    });
  }

  try {
    row.sourceProductCode = normalizeSku(row.sourceProductCode);
  } catch (error) {
    errors.add({
      row: rowNumber,
      column: 'Product Code',
      field: 'sourceProductCode',
      code: 'INVALID_PRODUCT_CODE',
      message: error.message,
    });
  }

  try {
    row.sku = normalizeSku(row.sku);
  } catch (error) {
    errors.add({
      row: rowNumber,
      column: 'SKU',
      field: 'sku',
      code: 'INVALID_SKU',
      message: error.message,
    });
  }

  try {
    row.color = normalizeSkuPart(row.color, 'Color');
  } catch (error) {
    errors.add({
      row: rowNumber,
      column: 'Colour',
      field: 'color',
      code: 'INVALID_COLOR',
      message: error.message,
    });
  }

  try {
    row.sizeSet = normalizeSkuPart(row.sizeSet, 'Size set');
  } catch (error) {
    errors.add({
      row: rowNumber,
      column: 'Size',
      field: 'sizeSet',
      code: 'INVALID_SIZE_SET',
      message: error.message,
    });
  }

  if (!errors.invalidRows.has(rowNumber)) {
    const generatedSku = generateSku(row.productName, row.color, row.sizeSet);

    if (generatedSku !== row.sku) {
      warnings.add({
        row: rowNumber,
        column: 'SKU',
        code: 'SKU_DIFFERS_FROM_GENERATED',
        message: `Source SKU ${row.sku} is preserved; current generator would produce ${generatedSku}`,
      });
    }
  }

  return row;
};

const addGroupConflict = ({ group, field, errors, code, message }) => {
  group.rows.forEach((row) => {
    errors.add({
      row: row.rowNumber,
      column: FIELD_DEFINITIONS[field]?.label || field,
      field,
      code,
      message,
    });
  });
};

const buildGroups = (rows, errors, warnings) => {
  const groupsByCode = new Map();

  rows
    .filter((row) => !errors.invalidRows.has(row.rowNumber))
    .forEach((row) => {
      if (!groupsByCode.has(row.productCode)) {
        groupsByCode.set(row.productCode, {
          productCode: row.productCode,
          firstRow: row.rowNumber,
          rows: [],
        });
      }

      groupsByCode.get(row.productCode).rows.push(row);
    });

  const groups = [];

  groupsByCode.forEach((group) => {
    const first = group.rows[0];
    const productNames = new Set(
      group.rows.map((row) => comparisonText(row.productName)),
    );

    if (productNames.size > 1) {
      addGroupConflict({
        group,
        field: 'productName',
        errors,
        code: 'PRODUCT_IDENTITY_COLLISION',
        message: `Different product names normalize to product code ${group.productCode}`,
      });
    }

    const sharedComparisons = [
      ['category', (value) => comparisonText(value)],
      ['title', (value) => comparisonText(value)],
      ['mrp', (value) => value],
      ['status', (value) => value],
    ];

    sharedComparisons.forEach(([field, normalize]) => {
      const values = new Set(group.rows.map((row) => normalize(row[field])));

      if (values.size > 1) {
        addGroupConflict({
          group,
          field,
          errors,
          code: 'CONFLICTING_PRODUCT_FIELD',
          message: `${FIELD_DEFINITIONS[field]?.label || field} must be consistent for product ${group.productCode}`,
        });
      }
    });

    const descriptions = new Set(
      group.rows
        .map((row) => comparisonText(row.description))
        .filter(Boolean),
    );

    if (descriptions.size > 1) {
      addGroupConflict({
        group,
        field: 'description',
        errors,
        code: 'CONFLICTING_PRODUCT_FIELD',
        message: `Description must be consistent for product ${group.productCode}`,
      });
    }

    const product = {
      productName: first.productName,
      productCode: group.productCode,
      title: first.title,
      categoryName: first.category,
      description: group.rows.find((row) => row.description)?.description,
      mrp: first.mrp,
      images: [
        ...new Set(group.rows.flatMap((row) => row.images || [])),
      ],
      status: first.status,
    };

    if (product.images.length > 50) {
      addGroupConflict({
        group,
        field: 'images',
        errors,
        code: 'TOO_MANY_PRODUCT_IMAGES',
        message: `Product ${group.productCode} cannot contain more than 50 unique image references`,
      });
    }

    const varyingAttributes = [];

    PRODUCT_ATTRIBUTE_FIELDS.forEach((field) => {
      const values = [
        ...new Set(
          group.rows
            .map((row) => row[field])
            .filter(Boolean),
        ),
      ];

      if (values.length <= 1) {
        product[field] = values[0];
        return;
      }

      varyingAttributes.push(field);
      warnings.add({
        row: group.firstRow,
        column: FIELD_DEFINITIONS[field].label,
        code: 'VARIANT_ATTRIBUTE_OVERRIDE',
        message: `${FIELD_DEFINITIONS[field].label} varies within ${group.productCode} and will be stored per variant`,
      });
    });

    const variants = group.rows.map((row) => {
      const attributeOverrides = {};

      varyingAttributes.forEach((field) => {
        if (row[field]) {
          attributeOverrides[field] = row[field];
        }
      });

      return {
        rowNumber: row.rowNumber,
        color: row.color,
        sizeSet: row.sizeSet,
        sku: row.sku,
        sourceProductCode: row.sourceProductCode,
        attributeOverrides,
        status: row.status,
        initialStock: row.initialStock || 0,
        initialStockProvided: row.initialStockProvided,
        shelf: row.shelf,
      };
    });

    const combinations = new Map();

    variants.forEach((variant) => {
      const key = `${variant.color}\u0000${variant.sizeSet}`;

      if (!combinations.has(key)) {
        combinations.set(key, []);
      }

      combinations.get(key).push(variant);
    });

    combinations.forEach((duplicates) => {
      if (duplicates.length < 2) {
        return;
      }

      duplicates.forEach((variant) => {
        errors.add({
          row: variant.rowNumber,
          column: 'Colour / Size',
          field: 'variant',
          code: 'DUPLICATE_PRODUCT_VARIANT',
          message: `Duplicate ${group.productCode} / ${variant.color} / ${variant.sizeSet} variant`,
        });
      });
    });

    groups.push({ ...group, product, variants, varyingAttributes });
  });

  return groups.sort((left, right) => left.firstRow - right.firstRow);
};

const canonicalContentHash = (rows) => {
  const canonicalRows = rows
    .map((row) => ({
      productName: row.productName,
      productCode: row.productCode,
      sourceProductCode: row.sourceProductCode,
      sku: row.sku,
      category: row.category,
      title: row.title,
      color: row.color,
      sizeSet: row.sizeSet,
      mrp: row.mrp,
      fit: row.fit,
      patternWash: row.patternWash,
      fabric: row.fabric,
      sleeves: row.sleeves,
      waist: row.waist,
      description: row.description,
      images: [...(row.images || [])].sort(),
      status: row.status,
      initialStock: row.initialStock,
      shelf: row.shelf,
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalRows))
    .digest('hex');
};

const parseCatalogWorkbook = async (buffer, { originalName = 'upload.xlsx' } = {}) => {
  let sheets;

  try {
    sheets = await readWorkbook(buffer);
  } catch (error) {
    throw new ApiError(422, 'Uploaded file is not a valid XLSX workbook');
  }

  if (!Array.isArray(sheets) || sheets.length === 0) {
    throw new ApiError(422, 'Uploaded workbook does not contain any worksheets');
  }

  const errors = createIssueCollector();
  const warnings = createIssueCollector();
  const selection = selectDataSheet(sheets);
  const selectedSheet = selection.selected?.sheet;
  const inspection = selection.selected?.inspection || {
    duplicateFields: [],
    fieldIndexes: new Map(),
    ignoredHeaders: [],
    missingRequiredFields: REQUIRED_FIELDS,
  };
  const rawRows = selectedSheet?.data || [];
  const nonBlankRows = rawRows
    .slice(1)
    .filter((row) => Array.isArray(row) && !row.every(isBlankCell));
  const totalRows = nonBlankRows.length;

  inspection.missingRequiredFields.forEach((field) => {
    errors.add({
      row: 1,
      column: FIELD_DEFINITIONS[field].label,
      field,
      code: 'MISSING_REQUIRED_COLUMN',
      message: `Required column is missing: ${FIELD_DEFINITIONS[field].label}`,
    });
  });

  inspection.duplicateFields.forEach(({ field, header }) => {
    errors.add({
      row: 1,
      column: header,
      field,
      code: 'DUPLICATE_COLUMN',
      message: `Multiple columns map to ${FIELD_DEFINITIONS[field].label}`,
    });
  });

  if (selection.eligibleCount > 1) {
    warnings.add({
      row: 1,
      column: 'FILE',
      code: 'MULTIPLE_DATA_SHEETS',
      message: `Multiple worksheets match the import format; ${selectedSheet.sheet} was selected`,
    });
  }

  if (totalRows === 0) {
    errors.add({
      row: 1,
      column: 'FILE',
      code: 'EMPTY_WORKSHEET',
      message: 'The selected worksheet must contain at least one product row',
    });
  }

  if (totalRows > MAX_IMPORT_ROWS) {
    errors.add({
      row: 1,
      column: 'FILE',
      code: 'ROW_LIMIT_EXCEEDED',
      message: `The worksheet cannot contain more than ${MAX_IMPORT_ROWS} product rows`,
    });
  }

  const rows = [];

  if (
    inspection.missingRequiredFields.length === 0 &&
    inspection.duplicateFields.length === 0 &&
    totalRows <= MAX_IMPORT_ROWS
  ) {
    rawRows.slice(1).forEach((rawRow, index) => {
      if (!Array.isArray(rawRow) || rawRow.every(isBlankCell)) {
        return;
      }

      rows.push(
        normalizeRow({
          rawRow,
          rowNumber: index + 2,
          fieldIndexes: inspection.fieldIndexes,
          errors,
          warnings,
        }),
      );
    });
  }

  const duplicateSkus = [];
  const rowsBySku = new Map();

  rows
    .filter((row) => row.sku)
    .forEach((row) => {
      if (!rowsBySku.has(row.sku)) {
        rowsBySku.set(row.sku, []);
      }

      rowsBySku.get(row.sku).push(row);
    });

  rowsBySku.forEach((duplicateRows, sku) => {
    if (duplicateRows.length < 2) {
      return;
    }

    const rowNumbers = duplicateRows.map(({ rowNumber }) => rowNumber);
    duplicateSkus.push({ sku, rows: rowNumbers });
    duplicateRows.forEach((row) => {
      errors.add({
        row: row.rowNumber,
        column: 'SKU',
        field: 'sku',
        code: 'DUPLICATE_SKU',
        message: `SKU ${sku} appears on rows ${rowNumbers.join(', ')}`,
      });
    });
  });

  const groups = buildGroups(rows, errors, warnings);
  const missingRequiredFields = errors.issues.filter(
    ({ code }) =>
      code === 'MISSING_REQUIRED_FIELD' || code === 'MISSING_REQUIRED_COLUMN',
  );
  const rawFileHash = crypto.createHash('sha256').update(buffer).digest('hex');
  const contentHash = canonicalContentHash(rows);
  const invalidRows = errors.invalidRows.size;

  return {
    source: {
      fileName: originalName,
      sheetName: selectedSheet?.sheet || null,
      rawFileHash,
      contentHash,
      ignoredSheets: sheets
        .map(({ sheet }) => sheet)
        .filter((sheetName) => sheetName !== selectedSheet?.sheet),
      ignoredHeaders: inspection.ignoredHeaders,
    },
    rows,
    groups,
    totalRows,
    validRows: Math.max(0, totalRows - invalidRows),
    invalidRows:
      errors.issues.some(({ row }) => row === 1) && rows.length === 0
        ? totalRows
        : invalidRows,
    duplicateSkus,
    missingRequiredFields,
    errors: errors.issues,
    warnings: warnings.issues,
    invalidRowNumbers: [...errors.invalidRows],
    errorCount: errors.count,
    warningCount: warnings.count,
    errorsTruncated: errors.truncated,
    warningsTruncated: warnings.truncated,
  };
};

module.exports = {
  parseCatalogWorkbook,
};
