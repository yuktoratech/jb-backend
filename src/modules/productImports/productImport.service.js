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
const ProductImportBatch = require('./productImport.model');
const { MAX_ISSUES } = require('./productImport.constants');
const { parseWorkbook } = require('./productImport.parser');

const COLLATION = { locale: 'en', strength: 2 };
const key = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
const id = (value) => value?.toString();
const sameId = (left, right) => id(left) === id(right);
const issueKey = (issue) => `${issue.rowNumber}\0${issue.field}\0${issue.code}\0${issue.message}`;

const addIssue = (state, issue) => {
  const signature = issueKey(issue);
  if (state.issueKeys.has(signature)) return;
  state.issueKeys.add(signature);
  if (state.errors.length < MAX_ISSUES) state.errors.push(issue);
  if (issue.rowNumber > 1) state.invalidRows.add(issue.rowNumber);
};

const loadNamedMasters = async (Model, values, session) => {
  const names = [...new Set(values.filter(Boolean))];
  if (!names.length) return [];
  return Model.find({ name: { $in: names } }).collation(COLLATION).session(session || null).lean();
};

const resolveMaster = (state, row, field, value, records) => {
  if (!value) return null;
  const matches = records.filter((record) => key(record.name) === key(value));
  if (!matches.length) {
    addIssue(state, { rowNumber: row.rowNumber, field, code: 'MASTER_NOT_FOUND', message: `${field} master "${value}" was not found` });
    return null;
  }
  if (matches.length > 1) {
    addIssue(state, { rowNumber: row.rowNumber, field, code: 'MASTER_AMBIGUOUS', message: `${field} master "${value}" is ambiguous` });
    return null;
  }
  if (matches[0].status !== 'active') {
    addIssue(state, { rowNumber: row.rowNumber, field, code: 'MASTER_INACTIVE', message: `${field} master "${value}" is inactive` });
    return null;
  }
  return matches[0];
};

const validateCatalog = async (sourceRows, initialErrors = [], { session } = {}) => {
  const state = { errors: [], invalidRows: new Set(), issueKeys: new Set() };
  initialErrors.forEach((error) => addIssue(state, error));
  const [categories, subCategories, colours, fits, fabrics, sizeSets] = await Promise.all([
    loadNamedMasters(Category, sourceRows.map((row) => row.categoryName), session),
    loadNamedMasters(SubCategory, sourceRows.map((row) => row.subCategoryName), session),
    loadNamedMasters(Colour, sourceRows.map((row) => row.colourName), session),
    loadNamedMasters(Fit, sourceRows.map((row) => row.fitName), session),
    loadNamedMasters(Fabric, sourceRows.map((row) => row.fabricName), session),
    SizeSet.find({ label: { $in: [...new Set(sourceRows.map((row) => row.sizeSetLabel).filter(Boolean))] } }).collation(COLLATION).session(session || null).lean(),
  ]);

  const rows = sourceRows.map((source) => {
    const row = { ...source };
    const category = resolveMaster(state, row, 'category', row.categoryName, categories);
    const subCategory = resolveMaster(state, row, 'subCategory', row.subCategoryName, subCategories);
    const colour = resolveMaster(state, row, 'colour', row.colourName, colours);
    const fit = resolveMaster(state, row, 'fit', row.fitName, fits);
    const fabric = resolveMaster(state, row, 'fabric', row.fabricName, fabrics);
    const sizeSet = resolveMaster(state, row, 'sizeSet', row.sizeSetLabel, sizeSets.map((entry) => ({ ...entry, name: entry.label })));
    if (category && subCategory && !sameId(subCategory.category, category._id)) addIssue(state, { rowNumber: row.rowNumber, field: 'subCategory', code: 'SUBCATEGORY_CATEGORY_MISMATCH', message: `Sub-category "${row.subCategoryName}" does not belong to Category "${row.categoryName}"` });
    Object.assign(row, {
      categoryId: category?._id, subCategoryId: subCategory?._id, colourId: colour?._id,
      fitId: fit?._id, fabricId: fabric?._id, sizeSetId: sizeSet?._id,
      sizes: sizeSet?.sizes, pieceCount: sizeSet?.pieceCount,
    });
    if (row.productCode && sizeSet) {
      try { row.expectedSku = generateSku(row.productCode, sizeSet.label); }
      catch (error) { addIssue(state, { rowNumber: row.rowNumber, field: 'productCode', code: 'INVALID_SKU', message: error.message }); }
    }
    return row;
  });

  const rowSignature = (row) => [row.productName, row.categoryName, row.subCategoryName, row.fitName, row.fabricName, row.description, row.mrpPerPieceMinor, row.colourName, row.productCode, row.sizeSetLabel, row.status].map(key).join('\0');
  const duplicateBuckets = new Map();
  rows.forEach((row) => { const signature = rowSignature(row); if (!duplicateBuckets.has(signature)) duplicateBuckets.set(signature, []); duplicateBuckets.get(signature).push(row); });
  duplicateBuckets.forEach((matches) => { if (matches.length > 1) matches.forEach((row) => addIssue(state, { rowNumber: row.rowNumber, field: 'row', code: 'DUPLICATE_ROW', message: 'This finalized Product import row is duplicated' })); });

  const groups = new Map();
  rows.forEach((row) => { const productKey = key(row.productName); if (!groups.has(productKey)) groups.set(productKey, []); groups.get(productKey).push(row); });
  for (const groupRows of groups.values()) {
    const first = groupRows[0];
    const shared = (row) => [id(row.categoryId), id(row.subCategoryId), id(row.fitId), id(row.fabricId), key(row.description), row.mrpPerPieceMinor, row.status].join('\0');
    if (groupRows.some((row) => shared(row) !== shared(first))) groupRows.forEach((row) => addIssue(state, { rowNumber: row.rowNumber, field: 'product', code: 'PRODUCT_METADATA_CONFLICT', message: `Rows for Product "${row.productName}" contain conflicting shared Product fields` }));
    const byColour = new Map();
    const byCombination = new Map();
    groupRows.forEach((row) => {
      const colourKey = id(row.colourId) || key(row.colourName);
      if (!byColour.has(colourKey)) byColour.set(colourKey, []);
      byColour.get(colourKey).push(row);
      const combination = `${colourKey}\0${id(row.sizeSetId) || key(row.sizeSetLabel)}`;
      if (!byCombination.has(combination)) byCombination.set(combination, []);
      byCombination.get(combination).push(row);
    });
    byColour.forEach((matches) => {
      if (new Set(matches.map((row) => row.productCode)).size > 1) matches.forEach((row) => addIssue(state, { rowNumber: row.rowNumber, field: 'productCode', code: 'PRODUCT_CODE_CONFLICT', message: 'The same Product and Colour cannot use different Product Codes' }));
    });
    byCombination.forEach((matches) => {
      if (matches.length > 1) matches.forEach((row) => addIssue(state, { rowNumber: row.rowNumber, field: 'sizeSet', code: 'DUPLICATE_PRODUCT_COLOUR_SIZE_SET', message: 'The same ProductColour and Size Set appears more than once' }));
    });
  }
  const byCode = new Map();
  rows.forEach((row) => { if (!row.productCode) return; if (!byCode.has(row.productCode)) byCode.set(row.productCode, []); byCode.get(row.productCode).push(row); });
  byCode.forEach((matches) => {
    const identities = new Set(matches.map((row) => `${key(row.productName)}\0${id(row.colourId) || key(row.colourName)}`));
    if (identities.size > 1) matches.forEach((row) => addIssue(state, { rowNumber: row.rowNumber, field: 'productCode', code: 'PRODUCT_CODE_CONFLICT', message: `Product Code "${row.productCode}" maps to conflicting ProductColours` }));
  });

  const productNames = [...groups.values()].map((groupRows) => groupRows[0].productName).filter(Boolean);
  const existingProducts = productNames.length ? await Product.find({ catalogVersion: 2, name: { $in: productNames } }).collation(COLLATION).session(session || null).lean() : [];
  for (const groupRows of groups.values()) {
    const matching = existingProducts.filter((product) => key(product.name) === key(groupRows[0].productName));
    if (matching.length > 1) groupRows.forEach((row) => addIssue(state, { rowNumber: row.rowNumber, field: 'productName', code: 'EXISTING_CATALOG_CONFLICT', message: `More than one existing Product matches "${row.productName}"` }));
    const product = matching[0];
    if (product) {
      const first = groupRows[0];
      const identical = sameId(product.category, first.categoryId) && sameId(product.subCategory, first.subCategoryId) && sameId(product.fitId, first.fitId) && sameId(product.fabricId, first.fabricId) && key(product.description || '') === key(first.description || '') && product.mrpPerPieceMinor === first.mrpPerPieceMinor && product.status === first.status;
      if (!identical) groupRows.forEach((row) => addIssue(state, { rowNumber: row.rowNumber, field: 'product', code: 'EXISTING_CATALOG_CONFLICT', message: `Existing Product "${row.productName}" has conflicting metadata, MRP, or status` }));
      else groupRows.forEach((row) => { row.existingProductId = product._id; });
    }
  }

  const productIds = rows.map((row) => row.existingProductId).filter(Boolean);
  const codes = rows.map((row) => row.productCode).filter(Boolean);
  const existingColours = codes.length || productIds.length ? await ProductColour.find({ $or: [{ productCode: { $in: codes } }, { product: { $in: productIds } }] }).session(session || null).lean() : [];
  for (const row of rows) {
    if (!row.productCode) continue;
    const coded = existingColours.find((entry) => entry.productCode === row.productCode);
    const paired = row.existingProductId && row.colourId ? existingColours.find((entry) => sameId(entry.product, row.existingProductId) && sameId(entry.colour, row.colourId)) : null;
    if ((coded && (!sameId(coded.product, row.existingProductId) || !sameId(coded.colour, row.colourId))) || (paired && paired.productCode !== row.productCode)) addIssue(state, { rowNumber: row.rowNumber, field: 'productCode', code: 'PRODUCT_CODE_CONFLICT', message: `Product Code "${row.productCode}" conflicts with an existing ProductColour` });
    else if (coded || paired) {
      const existing = coded || paired;
      if (existing.status !== row.status) addIssue(state, { rowNumber: row.rowNumber, field: 'status', code: 'EXISTING_CATALOG_CONFLICT', message: `Existing ProductColour "${row.productCode}" has a conflicting status` });
      else row.existingProductColourId = existing._id;
    }
  }

  const expectedSkus = rows.map((row) => row.expectedSku).filter(Boolean);
  const productColourIds = rows.map((row) => row.existingProductColourId).filter(Boolean);
  const existingVariants = expectedSkus.length || productColourIds.length ? await ProductVariant.find({ $or: [{ sku: { $in: expectedSkus } }, { productColour: { $in: productColourIds } }] }).session(session || null).lean() : [];
  for (const row of rows) {
    if (!row.expectedSku) continue;
    const skuMatch = existingVariants.find((entry) => entry.sku === row.expectedSku);
    const pairMatch = row.existingProductColourId && row.sizeSetId ? existingVariants.find((entry) => sameId(entry.productColour, row.existingProductColourId) && sameId(entry.sizeSetRef, row.sizeSetId)) : null;
    if ((skuMatch && (!sameId(skuMatch.productColour, row.existingProductColourId) || !sameId(skuMatch.sizeSetRef, row.sizeSetId))) || (pairMatch && pairMatch.sku !== row.expectedSku)) addIssue(state, { rowNumber: row.rowNumber, field: 'sku', code: 'EXISTING_CATALOG_CONFLICT', message: `Generated SKU "${row.expectedSku}" conflicts with existing catalog data` });
    else if (skuMatch || pairMatch) {
      const existing = skuMatch || pairMatch;
      if (existing.status !== row.status) addIssue(state, { rowNumber: row.rowNumber, field: 'status', code: 'EXISTING_CATALOG_CONFLICT', message: `Existing SKU "${row.expectedSku}" has a conflicting status` });
      else row.existingVariantId = existing._id;
    }
  }

  rows.forEach((row) => { row.validationStatus = state.invalidRows.has(row.rowNumber) ? 'INVALID' : 'VALID'; });
  return { rows, errors: state.errors, invalidRows: state.invalidRows.size };
};

const presentBatch = (batch) => ({
  id: id(batch._id), status: batch.status, originalFilename: batch.originalFilename,
  contentHash: batch.contentHash, totalRows: batch.totalRows, validRows: batch.validRows,
  invalidRows: batch.invalidRows, normalizedRows: batch.normalizedRows, errors: batch.errors,
  warnings: batch.warnings, createdAt: batch.createdAt, expiresAt: batch.expiresAt,
  appliedAt: batch.appliedAt, result: batch.result,
});

const previewImport = async (buffer, { uploadedBy, originalFilename }) => {
  const parsed = await parseWorkbook(buffer);
  if (!parsed.rows.length && !parsed.errors.length) parsed.errors.push({ rowNumber: 1, field: 'workbook', code: 'NO_DATA_ROWS', message: 'The workbook contains no Product data rows' });
  const validated = await validateCatalog(parsed.rows, parsed.errors);
  const hasWorkbookError = validated.errors.some((error) => error.rowNumber === 1);
  const invalidRows = hasWorkbookError ? parsed.rows.length : validated.invalidRows;
  if (hasWorkbookError) validated.rows.forEach((row) => { row.validationStatus = 'INVALID'; });
  const batch = await ProductImportBatch.create({
    uploadedBy, status: validated.errors.length ? 'INVALID' : 'VALID', originalFilename,
    contentHash: parsed.contentHash, totalRows: parsed.rows.length,
    validRows: Math.max(0, parsed.rows.length - invalidRows), invalidRows,
    normalizedRows: validated.rows, errors: validated.errors, warnings: parsed.warnings,
    expiresAt: ProductImportBatch.defaultExpiry(),
  });
  return presentBatch(batch.toObject());
};

const applyImport = async (batchId, { performedBy, afterCatalogWrites } = {}) => {
  await Promise.all([Product.init(), ProductColour.init(), ProductVariant.init(), ProductImportBatch.init()]);
  const session = await mongoose.startSession();
  let response;
  try {
    await session.withTransaction(async () => {
      const batch = await ProductImportBatch.findOne({ _id: batchId, uploadedBy: performedBy }).session(session);
      if (!batch) throw new ApiError(404, 'Product Import batch not found');
      if (batch.status === 'APPLIED') throw new ApiError(409, 'Product Import batch has already been applied');
      if (batch.status !== 'VALID') throw new ApiError(409, 'Invalid Product Import batch cannot be applied');
      if (batch.expiresAt <= new Date()) throw new ApiError(409, 'Product Import preview has expired');
      const revalidated = await validateCatalog(batch.normalizedRows.map((row) => ({ ...row, existingProductId: undefined, existingProductColourId: undefined, existingVariantId: undefined, validationStatus: undefined })), [], { session });
      if (revalidated.errors.length) throw new ApiError(409, 'Product Import preview is stale or conflicts with current catalog data', revalidated.errors);

      const counts = { createdProducts: 0, existingProducts: 0, createdProductColours: 0, existingProductColours: 0, createdVariants: 0, existingVariants: 0 };
      const groups = new Map();
      revalidated.rows.forEach((row) => { const productKey = key(row.productName); if (!groups.has(productKey)) groups.set(productKey, []); groups.get(productKey).push(row); });
      for (const groupRows of groups.values()) {
        const first = groupRows[0];
        let productId = first.existingProductId;
        if (!productId) {
          const [product] = await Product.create([{ catalogVersion: 2, name: first.productName, description: first.description, category: first.categoryId, subCategory: first.subCategoryId, fitId: first.fitId, fabricId: first.fabricId, mrpPerPieceMinor: first.mrpPerPieceMinor, status: first.status }], { session });
          productId = product._id; counts.createdProducts += 1;
        } else counts.existingProducts += 1;
        const colourGroups = new Map();
        groupRows.forEach((row) => { const colourKey = id(row.colourId); if (!colourGroups.has(colourKey)) colourGroups.set(colourKey, []); colourGroups.get(colourKey).push(row); });
        for (const colourRows of colourGroups.values()) {
          const colourFirst = colourRows[0];
          let productColourId = colourFirst.existingProductColourId;
          if (!productColourId) {
            const [productColour] = await ProductColour.create([{ product: productId, colour: colourFirst.colourId, productCode: colourFirst.productCode, images: [], status: colourFirst.status }], { session });
            productColourId = productColour._id; counts.createdProductColours += 1;
          } else counts.existingProductColours += 1;
          for (const row of colourRows) {
            if (row.existingVariantId) { counts.existingVariants += 1; continue; }
            await ProductVariant.create([{ catalogVersion: 2, product: productId, productColour: productColourId, sizeSetRef: row.sizeSetId, sku: generateSku(row.productCode, row.sizeSetLabel), status: row.status }], { session });
            counts.createdVariants += 1;
          }
        }
      }
      if (afterCatalogWrites) await afterCatalogWrites({ session, counts });
      const appliedAt = new Date();
      const updated = await ProductImportBatch.updateOne({ _id: batch._id, status: 'VALID' }, { $set: { status: 'APPLIED', appliedAt, appliedBy: performedBy, result: counts } }, { session });
      if (updated.modifiedCount !== 1) throw new ApiError(409, 'Product Import batch is already being applied');
      response = { ...counts, batchId: id(batch._id), status: 'APPLIED', appliedAt };
    });
    return response;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.code === 11000 || /WriteConflict|TransientTransactionError/.test(error?.message || '')) throw new ApiError(409, 'Product Import conflicts with a concurrent catalog change');
    throw error;
  } finally { await session.endSession(); }
};

module.exports = { applyImport, previewImport, validateCatalog };
