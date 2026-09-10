const mongoose = require('mongoose');

const Colour = require('../colours/colour.model');
const Fabric = require('../fabrics/fabric.model');
const Fit = require('../fits/fit.model');
const Inventory = require('../inventory/inventory.model');
const Product = require('../products/product.model');
const ProductColour = require('../productColours/productColour.model');
const SizeSet = require('../sizeSets/sizeSet.model');
const SubCategory = require('../subcategories/subCategory.model');
const User = require('../users/user.model');
const ProductVariant = require('../variants/productVariant.model');
const { normalizeProductCode, normalizeSku } = require('../../utils/sku');

const REPORT_VERSION = 1;
const LEGACY_RESERVATION_TYPES = ['ORDER_RESERVE', 'ORDER_RELEASE'];
const CRITICAL_CODES = new Set([
  'PRODUCT_CODE_COLLISION',
  'SKU_COLLISION',
  'UNKNOWN_SIZE_SET',
  'AMBIGUOUS_SIZE_SET',
  'AMBIGUOUS_PRODUCT_COLOUR',
  'ORPHAN_INVENTORY_REFERENCE',
  'NEGATIVE_SHELF_QUANTITY',
  'PRODUCT_MAPPING_INCOMPLETE',
  'INVALID_LEGACY_MRP',
]);

const id = (value) => value == null ? null : String(value);
const textKey = (value) => typeof value === 'string'
  ? value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')
  : '';
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const safelyNormalize = (normalizer, value) => {
  try { return normalizer(value); } catch { return ''; }
};
const issue = (area, code, documentId, message, details = {}) => ({
  area, code, documentId: id(documentId), message, details,
  critical: CRITICAL_CODES.has(code),
});

const rupeesToMinor = (value) => {
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error('MRP is not numeric');
  const normalized = String(value).trim();
  const match = normalized.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error('MRP must have at most two decimal places');
  const minor = (BigInt(match[1]) * 100n) + BigInt((match[2] || '').padEnd(2, '0'));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('MRP exceeds safe integer range');
  return Number(minor);
};

const createCounts = () => ({ scanned: 0, valid: 0, migrated: 0, skipped: 0, ambiguous: 0, errors: 0 });
const addIssue = (report, entry) => {
  report.issues.push(entry);
  const counts = report.areas[entry.area];
  if (entry.code.includes('AMBIGUOUS')) counts.ambiguous += 1;
  else counts.errors += 1;
};

const indexByText = (documents, field) => {
  const result = new Map();
  for (const document of documents) {
    const key = textKey(document[field]);
    if (!key) continue;
    const list = result.get(key) || [];
    list.push(document);
    result.set(key, list);
  }
  return result;
};

const buildPlan = async () => {
  const db = mongoose.connection.db;
  const [products, variants, productColours, colours, sizeSets, fits, fabrics, subCategories,
    inventories, users, orders, ledger] = await Promise.all([
    db.collection(Product.collection.name).find({}).toArray(),
    db.collection(ProductVariant.collection.name).find({}).toArray(),
    db.collection(ProductColour.collection.name).find({}).toArray(),
    db.collection(Colour.collection.name).find({}).toArray(),
    db.collection(SizeSet.collection.name).find({}).toArray(),
    db.collection(Fit.collection.name).find({}).toArray(),
    db.collection(Fabric.collection.name).find({}).toArray(),
    db.collection(SubCategory.collection.name).find({}).toArray(),
    db.collection(Inventory.collection.name).find({}).toArray(),
    db.collection(User.collection.name).find({ role: { $in: ['wholesaler', 'retailer'] } }).toArray(),
    db.collection('orders').find({}).toArray(),
    db.collection('inventorytransactions').find({ type: { $in: LEGACY_RESERVATION_TYPES }, legacyReservationEntry: { $ne: true } }).toArray(),
  ]);

  const report = {
    reportVersion: REPORT_VERSION,
    mode: 'dry-run',
    canApply: true,
    generatedAt: new Date().toISOString(),
    areas: {
      catalog: createCounts(), inventory: createCounts(), orders: createCounts(),
      accounts: createCounts(), images: createCounts(),
    },
    issues: [],
    legacyRetained: {
      productFields: 0, variantFields: 0, productImages: 0,
      reservationLedgerEntries: ledger.length, incompatibleOrders: 0, accountsMissingPhone: 0,
    },
  };
  const plan = { productUpdates: [], colourCreates: [], productColourCreates: [], variantUpdates: [], inventoryUpdates: [], orderUpdates: [], ledgerUpdates: [] };
  const productById = new Map(products.map((value) => [id(value._id), value]));
  const variantById = new Map(variants.map((value) => [id(value._id), value]));
  const colourByName = indexByText(colours, 'name');
  const sizeSetByLabel = indexByText(sizeSets, 'label');
  const fitByName = indexByText(fits, 'name');
  const fabricByName = indexByText(fabrics, 'name');
  const subCategoryById = new Map(subCategories.map((value) => [id(value._id), value]));
  const pcByPair = new Map();
  const pcCodeOwners = new Map();
  const skuOwners = new Map();
  for (const pc of productColours) {
    const pairKey = `${id(pc.product)}\0${id(pc.colour)}`;
    const pairOwners = pcByPair.get(pairKey) || [];
    pairOwners.push(pc); pcByPair.set(pairKey, pairOwners);
    const code = safelyNormalize(normalizeProductCode, pc.productCode);
    const owners = pcCodeOwners.get(code) || [];
    owners.push(id(pc._id)); pcCodeOwners.set(code, owners);
  }
  for (const variant of variants) {
    const sku = safelyNormalize(normalizeSku, variant.sku);
    const owners = skuOwners.get(sku) || [];
    owners.push(id(variant._id)); skuOwners.set(sku, owners);
  }
  for (const [code, owners] of pcCodeOwners) {
    if (code && new Set(owners).size > 1) addIssue(report, issue('catalog', 'PRODUCT_CODE_COLLISION', owners[0], `Existing ProductColour codes collide after normalization: ${code}`, { documentIds: owners }));
  }
  for (const [sku, owners] of skuOwners) {
    if (sku && new Set(owners).size > 1) addIssue(report, issue('catalog', 'SKU_COLLISION', owners[0], `Existing SKUs collide after normalization: ${sku}`, { documentIds: owners }));
  }

  const plannedColourByName = new Map();
  const resolveColour = (name, documentId) => {
    const key = textKey(name);
    const existing = colourByName.get(key) || [];
    if (existing.length > 1) {
      addIssue(report, issue('catalog', 'AMBIGUOUS_PRODUCT_COLOUR', documentId, `Colour ${name} matches multiple masters`));
      return null;
    }
    if (existing.length === 1) return existing[0];
    if (!key) {
      addIssue(report, issue('catalog', 'AMBIGUOUS_PRODUCT_COLOUR', documentId, 'Legacy colour is empty'));
      return null;
    }
    if (!plannedColourByName.has(key)) {
      const created = { _id: new mongoose.Types.ObjectId(), name: String(name).trim(), status: 'active' };
      plannedColourByName.set(key, created); plan.colourCreates.push(created);
    }
    return plannedColourByName.get(key);
  };

  for (const product of products) {
    report.areas.catalog.scanned += 1;
    const legacy = product.catalogVersion !== 2;
    if (Array.isArray(product.images) && product.images.length) {
      report.areas.images.scanned += product.images.length;
      report.areas.images.ambiguous += product.images.length;
      report.legacyRetained.productImages += product.images.length;
      report.issues.push(issue('images', 'MANUAL_IMAGE_ASSIGNMENT_REQUIRED', product._id, 'Product-level images require explicit ProductColour assignment', { count: product.images.length }));
    }
    if (!legacy) { report.areas.catalog.valid += 1; continue; }
    report.legacyRetained.productFields += 1;
    const updates = { catalogVersion: 2, name: product.name || product.productName || product.title };
    try { updates.mrpPerPieceMinor = product.mrpPerPieceMinor ?? rupeesToMinor(product.mrp); }
    catch (error) { addIssue(report, issue('catalog', 'INVALID_LEGACY_MRP', product._id, error.message)); }
    const fitMatches = product.fitId ? [{ _id: product.fitId }] : (fitByName.get(textKey(product.fit)) || []);
    const fabricMatches = product.fabricId ? [{ _id: product.fabricId }] : (fabricByName.get(textKey(product.fabric)) || []);
    const subCategory = subCategoryById.get(id(product.subCategory));
    if (fitMatches.length === 1) updates.fitId = fitMatches[0]._id;
    if (fabricMatches.length === 1) updates.fabricId = fabricMatches[0]._id;
    if (subCategory && id(subCategory.category) === id(product.category)) updates.subCategory = subCategory._id;
    const missing = ['name', 'mrpPerPieceMinor', 'fitId', 'fabricId', 'subCategory'].filter((field) => updates[field] == null);
    if (missing.length) addIssue(report, issue('catalog', 'PRODUCT_MAPPING_INCOMPLETE', product._id, `Finalized Product mapping is missing: ${missing.join(', ')}`));
    else { plan.productUpdates.push({ _id: product._id, updates }); report.areas.catalog.valid += 1; }
  }

  for (const variant of variants) {
    report.areas.catalog.scanned += 1;
    if (variant.catalogVersion === 2 && variant.productColour && variant.sizeSetRef) { report.areas.catalog.valid += 1; continue; }
    report.legacyRetained.variantFields += 1;
    const product = productById.get(id(variant.product));
    if (!product) { addIssue(report, issue('catalog', 'PRODUCT_MAPPING_INCOMPLETE', variant._id, 'Variant references a missing Product')); continue; }
    const colour = resolveColour(variant.color, variant._id);
    const sizeMatches = sizeSetByLabel.get(textKey(variant.sizeSet)) || [];
    if (sizeMatches.length !== 1) {
      addIssue(report, issue('catalog', sizeMatches.length ? 'AMBIGUOUS_SIZE_SET' : 'UNKNOWN_SIZE_SET', variant._id, `SizeSet ${variant.sizeSet || '(empty)'} cannot be resolved uniquely`));
      continue;
    }
    if (!colour) continue;
    const pairKey = `${id(product._id)}\0${id(colour._id)}`;
    let pairMatches = pcByPair.get(pairKey) || [];
    const rawCode = variant.sourceProductCode || product.productCode;
    const productCode = safelyNormalize(normalizeProductCode, rawCode);
    if (!productCode) { addIssue(report, issue('catalog', 'AMBIGUOUS_PRODUCT_COLOUR', variant._id, 'No usable legacy Product Code exists')); continue; }
    if (pairMatches.length > 1) { addIssue(report, issue('catalog', 'AMBIGUOUS_PRODUCT_COLOUR', variant._id, 'Product and Colour map to multiple ProductColours')); continue; }
    let productColour = pairMatches[0];
    if (!productColour) {
      productColour = { _id: new mongoose.Types.ObjectId(), product: product._id, colour: colour._id, productCode, images: [], status: 'active' };
      plan.productColourCreates.push(productColour); pcByPair.set(pairKey, [productColour]);
    } else if (safelyNormalize(normalizeProductCode, productColour.productCode) !== productCode) {
      addIssue(report, issue('catalog', 'AMBIGUOUS_PRODUCT_COLOUR', variant._id, 'Legacy Product Code disagrees with existing ProductColour', { legacyCode: productCode, existingCode: productColour.productCode }));
      continue;
    }
    const codeOwners = pcCodeOwners.get(productCode) || [];
    if (codeOwners.some((owner) => owner !== id(productColour._id))) addIssue(report, issue('catalog', 'PRODUCT_CODE_COLLISION', variant._id, `Normalized Product Code ${productCode} is not globally unique`));
    else pcCodeOwners.set(productCode, [id(productColour._id)]);
    const sku = safelyNormalize(normalizeSku, variant.sku);
    const skuCollision = (skuOwners.get(sku) || []).some((owner) => owner !== id(variant._id));
    if (!sku || skuCollision) { addIssue(report, issue('catalog', 'SKU_COLLISION', variant._id, `Normalized SKU ${sku || '(empty)'} is invalid or collides`)); continue; }
    plan.variantUpdates.push({ _id: variant._id, updates: { catalogVersion: 2, productColour: productColour._id, sizeSetRef: sizeMatches[0]._id, sku, status: variant.status === 'inactive' ? 'inactive' : 'active' } });
    report.areas.catalog.valid += 1;
  }

  for (const inventory of inventories) {
    report.areas.inventory.scanned += 1;
    const variant = variantById.get(id(inventory.variant));
    if (!variant) addIssue(report, issue('inventory', 'ORPHAN_INVENTORY_REFERENCE', inventory._id, 'Inventory references a missing ProductVariant'));
    const negativeShelves = (inventory.shelves || []).filter((shelf) => !Number.isSafeInteger(shelf.quantity) || shelf.quantity < 0);
    if (negativeShelves.length) addIssue(report, issue('inventory', 'NEGATIVE_SHELF_QUANTITY', inventory._id, 'Inventory contains invalid or negative physical shelf quantities'));
    const hasReservations = hasOwn(inventory, 'reservedQuantity') || hasOwn(inventory, 'reservedShelves');
    const variantPlan = plan.variantUpdates.find((entry) => id(entry._id) === id(inventory.variant));
    if (!negativeShelves.length && variant && (hasReservations || variantPlan)) {
      plan.inventoryUpdates.push({ _id: inventory._id, sku: variantPlan?.updates.sku, clearReservations: hasReservations });
    }
    if (!negativeShelves.length && variant) report.areas.inventory.valid += 1;
  }
  for (const entry of ledger) plan.ledgerUpdates.push(entry._id);

  for (const user of users) {
    report.areas.accounts.scanned += 1;
    if (!user.phone) {
      report.areas.accounts.skipped += 1; report.legacyRetained.accountsMissingPhone += 1;
      addIssue(report, issue('accounts', 'MISSING_MANDATORY_PHONE', user._id, `${user.role} has no phone number`));
    } else report.areas.accounts.valid += 1;
  }

  for (const order of orders) {
    report.areas.orders.scanned += 1;
    const rejected = order.status === 'REJECTED';
    const items = Array.isArray(order.items) ? order.items : [];
    const pricingCompatible = Number.isSafeInteger(order.grossAmountMinor)
      && Number.isSafeInteger(order.discountAmountMinor) && Number.isSafeInteger(order.taxableAmountMinor)
      && order.gstPercent === 5 && Number.isSafeInteger(order.gstAmountMinor)
      && Number.isSafeInteger(order.finalAmountMinor)
      && items.length > 0 && items.every((item) => Number.isSafeInteger(item.piecesPerSet)
        && item.piecesPerSet > 0 && Number.isSafeInteger(item.mrpPerPieceMinor));
    if (!pricingCompatible) {
      report.areas.orders.skipped += 1; report.legacyRetained.incompatibleOrders += 1;
      addIssue(report, issue('orders', 'INCOMPATIBLE_LEGACY_ORDER_PRICING', order._id, 'Historical pricing lacks reliable minor-unit, SizeSet piece-count, or GST snapshots; amounts were not recalculated'));
    } else report.areas.orders.valid += 1;
    if (rejected) plan.orderUpdates.push(order._id);
  }

  for (const values of pcCodeOwners.values()) if (new Set(values).size > 1) report.canApply = false;
  for (const values of skuOwners.values()) if (new Set(values).size > 1) report.canApply = false;
  if (report.issues.some((entry) => entry.critical)) report.canApply = false;
  for (const counts of Object.values(report.areas)) {
    counts.skipped = Math.max(counts.skipped, counts.scanned - counts.valid);
  }
  return { report, plan };
};

const executePlan = async (plan, report) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (plan.colourCreates.length) await Colour.collection.insertMany(plan.colourCreates.map((value) => ({ ...value, createdAt: new Date(), updatedAt: new Date() })), { session });
      for (const entry of plan.productUpdates) await Product.collection.updateOne({ _id: entry._id, catalogVersion: { $ne: 2 } }, { $set: { ...entry.updates, updatedAt: new Date() } }, { session });
      if (plan.productColourCreates.length) await ProductColour.collection.insertMany(plan.productColourCreates.map((value) => ({ ...value, createdAt: new Date(), updatedAt: new Date() })), { session });
      for (const entry of plan.variantUpdates) await ProductVariant.collection.updateOne({ _id: entry._id, catalogVersion: { $ne: 2 } }, { $set: { ...entry.updates, updatedAt: new Date() } }, { session });
      for (const entry of plan.inventoryUpdates) {
        const update = { $unset: { reservedQuantity: '', reservedShelves: '' }, $set: { updatedAt: new Date() } };
        if (entry.sku) update.$set.sku = entry.sku;
        await Inventory.collection.updateOne({ _id: entry._id }, update, { session });
      }
      for (const orderId of plan.orderUpdates) {
        await mongoose.connection.db.collection('orders').updateOne(
          { _id: orderId, status: 'REJECTED' },
          [{ $set: { status: 'CANCELLED', history: { $map: { input: { $ifNull: ['$history', []] }, as: 'event', in: { $mergeObjects: ['$$event', { previousStatus: { $cond: [{ $eq: ['$$event.previousStatus', 'REJECTED'] }, 'CANCELLED', '$$event.previousStatus'] }, newStatus: { $cond: [{ $eq: ['$$event.newStatus', 'REJECTED'] }, 'CANCELLED', '$$event.newStatus'] } }] } } }, updatedAt: '$$NOW' } }],
          { session },
        );
      }
      if (plan.ledgerUpdates.length) await mongoose.connection.db.collection('inventorytransactions').updateMany({ _id: { $in: plan.ledgerUpdates } }, { $set: { legacyReservationEntry: true } }, { session });
    });
  } finally { await session.endSession(); }
  report.mode = 'apply';
  report.areas.catalog.migrated = plan.productUpdates.length + plan.colourCreates.length + plan.productColourCreates.length + plan.variantUpdates.length;
  report.areas.inventory.migrated = plan.inventoryUpdates.length + plan.ledgerUpdates.length;
  report.areas.orders.migrated = plan.orderUpdates.length;
  return report;
};

const reconcileLegacyData = async ({ apply = false } = {}) => {
  const { report, plan } = await buildPlan();
  if (!apply) return report;
  if (!report.canApply) {
    const error = new Error('Migration blocked by critical collisions or ambiguities');
    error.code = 'MIGRATION_BLOCKED'; error.report = report; throw error;
  }
  return executePlan(plan, report);
};

module.exports = { reconcileLegacyData, rupeesToMinor };
