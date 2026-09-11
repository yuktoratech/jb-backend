const mongoose = require('mongoose');
const Category = require('../categories/category.model');
const SubCategory = require('../subcategories/subCategory.model');
const Colour = require('../colours/colour.model');
const Fit = require('../fits/fit.model');
const Fabric = require('../fabrics/fabric.model');
const SizeSet = require('../sizeSets/sizeSet.model');
const Product = require('../products/product.model');
const ProductColour = require('../productColours/productColour.model');
const ProductVariant = require('../variants/productVariant.model');
const ApiError = require('../../utils/ApiError');
const { generateSku } = require('../../utils/sku');
const { canonicalizeSizeSet, sameCanonicalSizes } = require('../sizeSets/sizeSetCanonical');
const { allocateProductCode, resolveOrCreateSizeSet } = require('../products/catalogGeneration.service');
const ProductImportBatch = require('./productImport.model');
const { MAX_ISSUES } = require('./productImport.constants');
const { parseWorkbook } = require('./productImport.parser');

const COLLATION = { locale: 'en', strength: 2 };
const key = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleUpperCase('en');
const id = (value) => value?.toString();
const sameId = (left, right) => id(left) === id(right);
const addIssue = (state, entry) => {
  const signature = `${entry.rowNumber}\0${entry.field}\0${entry.code}\0${entry.message}`;
  if (state.issueKeys.has(signature)) return;
  state.issueKeys.add(signature);
  if (state.errors.length < MAX_ISSUES) state.errors.push(entry);
  if (entry.rowNumber > 1) state.invalidRows.add(entry.rowNumber);
};
const loadNamedMasters = async (Model, values, session) => {
  const names = [...new Set(values.filter(Boolean))];
  return names.length ? Model.find({ name: { $in: names } }).collation(COLLATION).session(session || null).lean() : [];
};
const resolveMaster = (state, row, field, value, records) => {
  if (!value) return null;
  const matches = records.filter((record) => key(record.name) === key(value));
  if (!matches.length) addIssue(state, { rowNumber: row.rowNumber, field, code: 'MASTER_NOT_FOUND', message: `${field} ${value} was not found.` });
  else if (matches.length > 1) addIssue(state, { rowNumber: row.rowNumber, field, code: 'MASTER_AMBIGUOUS', message: `${field} ${value} is ambiguous.` });
  else if (matches[0].status !== 'active') addIssue(state, { rowNumber: row.rowNumber, field, code: 'MASTER_INACTIVE', message: `${field} ${value} is inactive.` });
  else return matches[0];
  return null;
};

const validateCatalog = async (sourceRows, initialErrors = [], { session } = {}) => {
  const state = { errors: [], invalidRows: new Set(), issueKeys: new Set() };
  initialErrors.forEach((error) => addIssue(state, error));
  const [categories, colours, fits, fabrics, sizeSets] = await Promise.all([
    loadNamedMasters(Category, sourceRows.map((row) => row.categoryName), session),
    loadNamedMasters(Colour, sourceRows.map((row) => row.colourName), session),
    loadNamedMasters(Fit, sourceRows.map((row) => row.fitName), session),
    loadNamedMasters(Fabric, sourceRows.map((row) => row.fabricName), session),
    SizeSet.find({}).session(session || null).lean(),
  ]);
  const subCategories = await SubCategory.find({ category: { $in: categories.map(({ _id }) => _id) }, status: 'active' }).session(session || null).lean();
  const rows = sourceRows.map((source) => {
    const row = { ...source };
    const category = resolveMaster(state, row, 'Category', row.categoryName, categories);
    const colour = resolveMaster(state, row, 'Colour', row.colourName, colours);
    const fit = resolveMaster(state, row, 'Fit', row.fitName, fits);
    const fabric = resolveMaster(state, row, 'Fabric', row.fabricName, fabrics);
    let subCategory;
    if (row.subCategoryName) subCategory = resolveMaster(state, row, 'Sub-category', row.subCategoryName, subCategories);
    else if (category) {
      const matches = subCategories.filter((entry) => sameId(entry.category, category._id));
      if (matches.length === 1) { [subCategory] = matches; row.subCategoryName = subCategory.name; }
      else addIssue(state, { rowNumber: row.rowNumber, field: 'subCategory', code: 'SUBCATEGORY_REQUIRED', message: `Category ${row.categoryName} needs a sub-category.` });
    }
    if (category && subCategory && !sameId(subCategory.category, category._id)) addIssue(state, { rowNumber: row.rowNumber, field: 'subCategory', code: 'SUBCATEGORY_CATEGORY_MISMATCH', message: `Sub-category ${row.subCategoryName} does not belong to category ${row.categoryName}.` });
    if (category && !category.sizeFamily) addIssue(state, { rowNumber: row.rowNumber, field: 'category', code: 'SIZE_FAMILY_REQUIRED', message: `Configure a size family for category ${row.categoryName}.` });
    let existingSizeSet;
    if (category?.sizeFamily && row.sizeSetLabel) {
      try {
        const canonical = canonicalizeSizeSet(row.sizeSetLabel, category.sizeFamily);
        row.sizeSetLabel = canonical.label; row.sizes = canonical.sizes; row.pieceCount = canonical.pieceCount;
        existingSizeSet = sizeSets.find((entry) => key(entry.label) === canonical.label && sameCanonicalSizes(entry.sizes, canonical.sizes));
        if (existingSizeSet?.status === 'inactive') addIssue(state, { rowNumber: row.rowNumber, field: 'sizeSet', code: 'MASTER_INACTIVE', message: `Size ${canonical.label} is inactive. Activate it before importing.` });
      } catch (error) { addIssue(state, { rowNumber: row.rowNumber, field: 'sizeSet', code: 'INVALID_SIZE', message: error.message }); }
    }
    Object.assign(row, { categoryId: category?._id, subCategoryId: subCategory?._id, colourId: colour?._id, fitId: fit?._id, fabricId: fabric?._id, sizeSetId: existingSizeSet?._id });
    return row;
  });
  const groups = new Map();
  rows.forEach((row) => { const groupKey = key(row.productName); if (!groups.has(groupKey)) groups.set(groupKey, []); groups.get(groupKey).push(row); });
  for (const groupRows of groups.values()) {
    const sharedFields = [
      ['category', (row) => id(row.categoryId), (row) => row.categoryName],
      ['subCategory', (row) => id(row.subCategoryId), (row) => row.subCategoryName],
      ['fit', (row) => id(row.fitId), (row) => row.fitName],
      ['fabric', (row) => id(row.fabricId), (row) => row.fabricName],
      ['description', (row) => key(row.description), (row) => row.description || '(empty)'],
      ['mrpPerPiece', (row) => row.mrpPerPieceMinor, (row) => row.mrpPerPieceMinor == null ? '(invalid)' : `₹${(row.mrpPerPieceMinor / 100).toFixed(2)}`],
      ['status', (row) => row.status, (row) => row.status],
    ];
    for (const [field, valueOf, displayOf] of sharedFields) {
      if (new Set(groupRows.map(valueOf)).size < 2) continue;
      groupRows.forEach((row) => addIssue(state, {
        rowNumber: row.rowNumber,
        field,
        code: 'PRODUCT_METADATA_CONFLICT',
        message: `${field === 'mrpPerPiece' ? 'MRP per piece' : field} for product ${row.productName} conflicts across rows (this row: ${displayOf(row)}). Use one value for every variant of the same product.`,
      }));
    }
    const combinations = new Map();
    groupRows.forEach((row) => { const combination = `${id(row.colourId) || key(row.colourName)}\0${row.sizeSetLabel}`; if (!combinations.has(combination)) combinations.set(combination, []); combinations.get(combination).push(row); });
    combinations.forEach((matches) => { if (matches.length > 1) matches.forEach((row) => addIssue(state, { rowNumber: row.rowNumber, field: 'sizeSet', code: 'DUPLICATE_PRODUCT_COLOUR_SIZE_SET', message: 'This Product, Colour and Size already appears in the workbook.' })); });
  }
  const names = [...groups.values()].map((entries) => entries[0].productName).filter(Boolean);
  const existingProducts = names.length ? await Product.find({ catalogVersion: 2, name: { $in: names } }).collation(COLLATION).session(session || null).lean() : [];
  for (const groupRows of groups.values()) {
    const first = groupRows[0]; const matches = existingProducts.filter((product) => key(product.name) === key(first.productName)); const product = matches[0];
    if (matches.length > 1) groupRows.forEach((row) => addIssue(state, { rowNumber: row.rowNumber, field: 'productName', code: 'EXISTING_CATALOG_CONFLICT', message: `More than one product matches ${row.productName}.` }));
    if (!product) continue;
    if (product.status !== 'active') groupRows.forEach((row) => addIssue(state, { rowNumber: row.rowNumber, field: 'product', code: 'PRODUCT_INACTIVE', message: 'This product is inactive. Activate it before importing.' }));
    const compatible = sameId(product.category, first.categoryId) && sameId(product.subCategory, first.subCategoryId) && sameId(product.fitId, first.fitId) && sameId(product.fabricId, first.fabricId) && (!first.description || key(product.description) === key(first.description));
    if (!compatible) groupRows.forEach((row) => addIssue(state, { rowNumber: row.rowNumber, field: 'product', code: 'EXISTING_CATALOG_CONFLICT', message: `Product ${row.productName} has conflicting Category, Sub-category, Fit, Fabric, or title.` }));
    else groupRows.forEach((row) => { row.existingProductId = product._id; row.mrpNeedsUpdate = product.mrpPerPieceMinor !== first.mrpPerPieceMinor; });
  }
  const productIds = rows.map((row) => row.existingProductId).filter(Boolean); const suppliedCodes = rows.map((row) => row.productCode).filter(Boolean);
  const existingColours = productIds.length || suppliedCodes.length ? await ProductColour.find({ $or: [{ product: { $in: productIds } }, { productCode: { $in: suppliedCodes } }] }).session(session || null).lean() : [];
  const expectedByLogical = new Map(); const reservedCodes = new Set();
  for (const row of rows) {
    if (!row.productName || !row.colourId) continue;
    const logicalKey = `${row.existingProductId || key(row.productName)}\0${row.colourId}`;
    const paired = row.existingProductId ? existingColours.find((entry) => sameId(entry.product, row.existingProductId) && sameId(entry.colour, row.colourId)) : null;
    let expectedCode = expectedByLogical.get(logicalKey);
    if (!expectedCode) {
      const colour = colours.find((entry) => sameId(entry._id, row.colourId));
      expectedCode = paired?.productCode || await allocateProductCode({ productId: row.existingProductId, colourId: row.colourId, productName: row.productName, colourName: colour.name, session, reserved: reservedCodes });
      expectedByLogical.set(logicalKey, expectedCode); reservedCodes.add(expectedCode);
    }
    row.expectedProductCode = expectedCode;
    const codeOwner = existingColours.find((entry) => entry.productCode === row.productCode);
    if (row.productCode !== expectedCode) addIssue(state, { rowNumber: row.rowNumber, field: 'productCode', code: 'PRODUCT_CODE_MISMATCH', message: codeOwner ? 'This Product Code belongs to another product or colour.' : `Product Code must be ${expectedCode}.` });
    if (paired) {
      if (paired.status !== 'active') addIssue(state, { rowNumber: row.rowNumber, field: 'colour', code: 'PRODUCT_COLOUR_INACTIVE', message: 'This colour is inactive. Activate it before importing.' });
      else row.existingProductColourId = paired._id;
    }
    if (row.sizeSetLabel) { row.expectedSku = generateSku(expectedCode, row.sizeSetLabel); if (row.suppliedSku !== row.expectedSku) addIssue(state, { rowNumber: row.rowNumber, field: 'sku', code: 'SKU_MISMATCH', message: `SKU must be ${row.expectedSku}.` }); }
  }
  const expectedSkus = rows.map((row) => row.expectedSku).filter(Boolean); const pcIds = rows.map((row) => row.existingProductColourId).filter(Boolean);
  const variants = expectedSkus.length || pcIds.length ? await ProductVariant.find({ $or: [{ sku: { $in: expectedSkus } }, { productColour: { $in: pcIds } }] }).session(session || null).lean() : [];
  rows.forEach((row) => {
    if (!row.expectedSku) return;
    const skuMatch = variants.find((entry) => entry.sku === row.expectedSku);
    const pairMatch = row.existingProductColourId && row.sizeSetId && variants.find((entry) => sameId(entry.productColour, row.existingProductColourId) && sameId(entry.sizeSetRef, row.sizeSetId));
    if (skuMatch && row.existingProductColourId && !sameId(skuMatch.productColour, row.existingProductColourId)) addIssue(state, { rowNumber: row.rowNumber, field: 'sku', code: 'SKU_CONFLICT', message: 'This SKU belongs to another product.' });
    else if (skuMatch || pairMatch) { const existing = skuMatch || pairMatch; if (existing.status !== 'active') addIssue(state, { rowNumber: row.rowNumber, field: 'sku', code: 'SKU_INACTIVE', message: 'This SKU is inactive. Activate it before importing.' }); else row.existingVariantId = existing._id; }
  });
  rows.forEach((row) => { row.validationStatus = state.invalidRows.has(row.rowNumber) ? 'INVALID' : 'VALID'; });
  return { rows, errors: state.errors, invalidRows: state.invalidRows.size };
};

const presentBatch = (batch) => ({ id: id(batch._id), status: batch.status, originalFilename: batch.originalFilename, contentHash: batch.contentHash, totalRows: batch.totalRows, validRows: batch.validRows, invalidRows: batch.invalidRows, normalizedRows: batch.normalizedRows, errors: batch.errors, warnings: batch.warnings, createdAt: batch.createdAt, expiresAt: batch.expiresAt, appliedAt: batch.appliedAt, result: batch.result });
const previewImport = async (buffer, { uploadedBy, originalFilename }) => {
  const parsed = await parseWorkbook(buffer);
  if (!parsed.rows.length && !parsed.errors.length) parsed.errors.push({ rowNumber: 1, field: 'workbook', code: 'NO_DATA_ROWS', message: 'The workbook contains no Product rows.' });
  const validated = await validateCatalog(parsed.rows, parsed.errors); const workbookError = validated.errors.some((error) => error.rowNumber === 1); const invalidRows = workbookError ? parsed.rows.length : validated.invalidRows;
  if (workbookError) validated.rows.forEach((row) => { row.validationStatus = 'INVALID'; });
  const batch = await ProductImportBatch.create({ uploadedBy, status: validated.errors.length ? 'INVALID' : 'VALID', originalFilename, contentHash: parsed.contentHash, totalRows: parsed.rows.length, validRows: Math.max(0, parsed.rows.length - invalidRows), invalidRows, normalizedRows: validated.rows, errors: validated.errors, warnings: parsed.warnings, expiresAt: ProductImportBatch.defaultExpiry() });
  return presentBatch(batch.toObject());
};
const cleanForRevalidation = (row) => ({ ...row, existingProductId: undefined, existingProductColourId: undefined, existingVariantId: undefined, validationStatus: undefined, expectedProductCode: undefined, expectedSku: undefined, mrpNeedsUpdate: undefined });
const applyImport = async (batchId, { performedBy, afterCatalogWrites } = {}) => {
  await Promise.all([Product.init(), ProductColour.init(), ProductVariant.init(), ProductImportBatch.init(), SizeSet.init()]); const session = await mongoose.startSession(); let response;
  try {
    await session.withTransaction(async () => {
      const batch = await ProductImportBatch.findOne({ _id: batchId, uploadedBy: performedBy }).session(session);
      if (!batch) throw new ApiError(404, 'Product Import batch not found');
      if (batch.status === 'APPLIED') throw new ApiError(409, 'Product Import batch has already been applied');
      if (batch.status !== 'VALID') throw new ApiError(409, 'Invalid Product Import batch cannot be applied');
      if (batch.expiresAt <= new Date()) throw new ApiError(409, 'Product Import preview has expired');
      const revalidated = await validateCatalog(batch.normalizedRows.map(cleanForRevalidation), [], { session });
      if (revalidated.errors.length) throw new ApiError(409, 'Product Import preview is stale or conflicts with current catalog data', revalidated.errors);
      const counts = { createdProducts: 0, existingProducts: 0, createdProductColours: 0, existingProductColours: 0, createdVariants: 0, existingVariants: 0 }; const groups = new Map();
      revalidated.rows.forEach((row) => { const groupKey = key(row.productName); if (!groups.has(groupKey)) groups.set(groupKey, []); groups.get(groupKey).push(row); });
      for (const groupRows of groups.values()) {
        const first = groupRows[0]; let productId = first.existingProductId;
        if (!productId) { const [product] = await Product.create([{ catalogVersion: 2, name: first.productName, description: first.description, category: first.categoryId, subCategory: first.subCategoryId, fitId: first.fitId, fabricId: first.fabricId, mrpPerPieceMinor: first.mrpPerPieceMinor, status: 'active' }], { session }); productId = product._id; counts.createdProducts += 1; }
        else { counts.existingProducts += 1; if (first.mrpNeedsUpdate) await Product.updateOne({ _id: productId, status: 'active' }, { $set: { mrpPerPieceMinor: first.mrpPerPieceMinor } }, { session }); }
        const colourGroups = new Map(); groupRows.forEach((row) => { const colourKey = id(row.colourId); if (!colourGroups.has(colourKey)) colourGroups.set(colourKey, []); colourGroups.get(colourKey).push(row); });
        for (const colourRows of colourGroups.values()) {
          const colourFirst = colourRows[0]; let productColourId = colourFirst.existingProductColourId;
          if (!productColourId) { const [pc] = await ProductColour.create([{ product: productId, colour: colourFirst.colourId, productCode: colourFirst.expectedProductCode, images: [], status: 'active' }], { session }); productColourId = pc._id; counts.createdProductColours += 1; } else counts.existingProductColours += 1;
          const category = await Category.findById(colourFirst.categoryId).session(session).lean();
          for (const row of colourRows) {
            if (row.existingVariantId) { counts.existingVariants += 1; continue; }
            const sizeSet = await resolveOrCreateSizeSet({ input: row.sizeSetLabel, sizeFamily: category.sizeFamily, session });
            await ProductVariant.create([{ catalogVersion: 2, product: productId, productColour: productColourId, sizeSetRef: sizeSet._id, sku: generateSku(colourFirst.expectedProductCode, sizeSet.label), status: 'active' }], { session }); counts.createdVariants += 1;
          }
        }
      }
      if (afterCatalogWrites) await afterCatalogWrites({ session, counts }); const appliedAt = new Date();
      const updated = await ProductImportBatch.updateOne({ _id: batch._id, status: 'VALID' }, { $set: { status: 'APPLIED', appliedAt, appliedBy: performedBy, result: counts } }, { session });
      if (updated.modifiedCount !== 1) throw new ApiError(409, 'Product Import batch is already being applied'); response = { ...counts, batchId: id(batch._id), status: 'APPLIED', appliedAt };
    }); return response;
  } catch (error) { if (error instanceof ApiError) throw error; if (error?.code === 11000 || /WriteConflict|TransientTransactionError/.test(error?.message || '')) throw new ApiError(409, 'Product Import conflicts with a concurrent catalog change'); throw error; }
  finally { await session.endSession(); }
};

module.exports = { applyImport, previewImport, validateCatalog };
