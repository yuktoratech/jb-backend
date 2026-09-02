const Category = require('../categories/category.model');
const categoryService = require('../categories/category.service');
const Inventory = require('../inventory/inventory.model');
const inventoryService = require('../inventory/inventory.service');
const InventoryTransaction = require('../inventory/inventoryTransaction.model');
const Product = require('../products/product.model');
const productService = require('../products/product.service');
const ProductVariant = require('../variants/productVariant.model');
const variantService = require('../variants/variant.service');
const ApiError = require('../../utils/ApiError');
const {
  FORMAT_VERSION,
  MAX_ISSUES,
  POLICY_VERSION,
  PRODUCT_ATTRIBUTE_FIELDS,
  REPORT_MAPPING,
} = require('./catalogMigration.constants');
const {
  parseCatalogWorkbook,
} = require('./catalogMigration.parser');

const CATEGORY_COLLATION = { locale: 'en', strength: 2 };
const INITIAL_STOCK_OPERATION_PREFIX = 'CATALOG_INITIAL_STOCK';
let importInProgress = false;

const createAppliedCounts = () => ({
  createdCategories: 0,
  createdProducts: 0,
  createdVariants: 0,
  createdInventories: 0,
  stockInitialized: 0,
  stockAlreadyInitialized: 0,
});

const normalizeTextForComparison = (value) =>
  value === undefined || value === null
    ? undefined
    : String(value).trim().replace(/\s+/g, ' ').toLowerCase();

const valuesMatch = (left, right) =>
  normalizeTextForComparison(left) === normalizeTextForComparison(right);

const objectIdString = (value) => value?.toString();

const variantCombinationKey = (productId, color, sizeSet) =>
  `${objectIdString(productId)}\u0000${color}\u0000${sizeSet}`;

const initialStockOperationKey = (sku, shelf) =>
  `${INITIAL_STOCK_OPERATION_PREFIX}:${sku}:${shelf}`;

const addPlanError = (state, rows, code, field, message) => {
  const rowNumbers = [...new Set(rows)].filter(Number.isInteger);

  rowNumbers.forEach((row) => state.invalidRows.add(row));
  state.errorCount += Math.max(1, rowNumbers.length);

  if (state.errors.length >= MAX_ISSUES) {
    state.errorsTruncated = true;
    return;
  }

  if (rowNumbers.length === 0) {
    state.errors.push({ row: 1, field, code, message });
    return;
  }

  for (const row of rowNumbers) {
    if (state.errors.length >= MAX_ISSUES) {
      state.errorsTruncated = true;
      break;
    }

    state.errors.push({ row, field, code, message });
  }
};

const productRows = (group) => group.rows.map(({ rowNumber }) => rowNumber);

const categoryRows = (groups, categoryName) =>
  groups
    .filter(({ product }) =>
      valuesMatch(product.categoryName, categoryName),
    )
    .flatMap(productRows);

const getCategoryActions = async (groups, state) => {
  const requestedCategories = [];
  const seenNames = new Set();

  groups.forEach((group) => {
    const key = normalizeTextForComparison(group.product.categoryName);

    if (!seenNames.has(key)) {
      seenNames.add(key);
      requestedCategories.push({
        name: group.product.categoryName,
        slug: categoryService.createCategorySlug(group.product.categoryName),
      });
    }
  });

  const names = requestedCategories.map(({ name }) => name);
  const slugs = requestedCategories.map(({ slug }) => slug);
  const existingCategories =
    names.length === 0
      ? []
      : await Category.find({
          $or: [{ name: { $in: names } }, { slug: { $in: slugs } }],
        })
          .collation(CATEGORY_COLLATION)
          .lean();
  const byName = new Map(
    existingCategories.map((category) => [
      normalizeTextForComparison(category.name),
      category,
    ]),
  );
  const bySlug = new Map(
    existingCategories.map((category) => [category.slug, category]),
  );
  const actions = new Map();

  requestedCategories.forEach(({ name, slug }) => {
    const key = normalizeTextForComparison(name);
    const namedCategory = byName.get(key);
    const slugCategory = bySlug.get(slug);
    const rows = categoryRows(groups, name);

    if (!slug) {
      addPlanError(
        state,
        rows,
        'INVALID_CATEGORY_SLUG',
        'category',
        `A valid slug cannot be generated for category ${name}`,
      );
      actions.set(key, { action: 'conflict', name, slug });
      return;
    }

    if (
      namedCategory &&
      slugCategory &&
      objectIdString(namedCategory._id) !== objectIdString(slugCategory._id)
    ) {
      addPlanError(
        state,
        rows,
        'CATEGORY_IDENTITY_CONFLICT',
        'category',
        `Category ${name} and generated slug ${slug} belong to different existing records`,
      );
      actions.set(key, { action: 'conflict', name, slug });
      return;
    }

    const existing = namedCategory || slugCategory;

    if (existing && !valuesMatch(existing.name, name)) {
      addPlanError(
        state,
        rows,
        'CATEGORY_SLUG_CONFLICT',
        'category',
        `Generated category slug ${slug} is already used by ${existing.name}`,
      );
      actions.set(key, { action: 'conflict', name, slug, existing });
      return;
    }

    if (existing?.status !== undefined && existing.status !== 'active') {
      addPlanError(
        state,
        rows,
        'INACTIVE_CATEGORY',
        'category',
        `Existing category ${existing.name} is inactive`,
      );
      actions.set(key, { action: 'conflict', name, slug, existing });
      return;
    }

    actions.set(key, {
      action: existing ? 'reuse' : 'create',
      name,
      slug,
      existing,
    });
  });

  return actions;
};

const compareExistingProduct = ({ existing, group, categoryAction, state }) => {
  const rows = productRows(group);
  const conflicts = [];
  const product = group.product;

  if (!valuesMatch(existing.productName, product.productName)) {
    conflicts.push('product name');
  }

  if (!valuesMatch(existing.title, product.title)) {
    conflicts.push('product title');
  }

  if (existing.mrp !== product.mrp) {
    conflicts.push('MRP');
  }

  if (existing.status !== product.status) {
    conflicts.push('status');
  }

  const existingCategoryName = existing.category?.name;

  if (!valuesMatch(existingCategoryName, product.categoryName)) {
    conflicts.push('category');
  }

  if (categoryAction.action === 'conflict') {
    conflicts.push('category mapping');
  }

  if (conflicts.length > 0) {
    addPlanError(
      state,
      rows,
      'EXISTING_PRODUCT_CONFLICT',
      'product',
      `Existing product ${group.productCode} differs in: ${[
        ...new Set(conflicts),
      ].join(', ')}`,
    );
    return { action: 'conflict', existing, updates: {} };
  }

  const updates = {};

  if (!existing.productCode) {
    updates.productCode = group.productCode;
  } else if (existing.productCode !== group.productCode) {
    addPlanError(
      state,
      rows,
      'EXISTING_PRODUCT_CODE_CONFLICT',
      'productCode',
      `Product ${product.productName} already uses product code ${existing.productCode}`,
    );
    return { action: 'conflict', existing, updates: {} };
  }

  ['description', ...PRODUCT_ATTRIBUTE_FIELDS].forEach((field) => {
    const sourceValue = product[field];

    if (!sourceValue) {
      return;
    }

    if (!existing[field]) {
      updates[field] = sourceValue;
      return;
    }

    if (!valuesMatch(existing[field], sourceValue)) {
      conflicts.push(field);
    }
  });

  if (conflicts.length > 0) {
    addPlanError(
      state,
      rows,
      'EXISTING_PRODUCT_METADATA_CONFLICT',
      'product',
      `Existing product ${group.productCode} has different ${[
        ...new Set(conflicts),
      ].join(', ')} metadata`,
    );
    return { action: 'conflict', existing, updates: {} };
  }

  const existingImages = new Set(existing.images || []);
  const missingImages = (product.images || []).filter(
    (image) => !existingImages.has(image),
  );

  if (missingImages.length > 0) {
    updates.images = [...existingImages, ...missingImages];
  }

  return {
    action: Object.keys(updates).length > 0 ? 'update' : 'reuse',
    existing,
    updates,
  };
};

const getProductActions = async (groups, categoryActions, state) => {
  const productCodes = groups.map(({ productCode }) => productCode);
  const productNames = groups.map(({ product }) => product.productName);
  const existingProducts =
    groups.length === 0
      ? []
      : await Product.find({
          $or: [
            { productCode: { $in: productCodes } },
            { productName: { $in: productNames } },
          ],
        })
          .collation(CATEGORY_COLLATION)
          .populate('category', '_id name status')
          .lean();
  const byCode = new Map(
    existingProducts
      .filter(({ productCode }) => productCode)
      .map((product) => [product.productCode, product]),
  );
  const byName = new Map(
    existingProducts.map((product) => [
      normalizeTextForComparison(product.productName),
      product,
    ]),
  );
  const actions = new Map();

  groups.forEach((group) => {
    const namedProduct = byName.get(
      normalizeTextForComparison(group.product.productName),
    );
    const codedProduct = byCode.get(group.productCode);
    const rows = productRows(group);
    const categoryAction = categoryActions.get(
      normalizeTextForComparison(group.product.categoryName),
    );

    if (
      namedProduct &&
      codedProduct &&
      objectIdString(namedProduct._id) !== objectIdString(codedProduct._id)
    ) {
      addPlanError(
        state,
        rows,
        'PRODUCT_IDENTITY_CONFLICT',
        'product',
        `Product name ${group.product.productName} and code ${group.productCode} belong to different records`,
      );
      actions.set(group.productCode, {
        action: 'conflict',
        group,
      });
      return;
    }

    if (
      namedProduct?.productCode &&
      namedProduct.productCode !== group.productCode
    ) {
      addPlanError(
        state,
        rows,
        'PRODUCT_CODE_CONFLICT',
        'productCode',
        `Product ${group.product.productName} already uses product code ${namedProduct.productCode}`,
      );
      actions.set(group.productCode, {
        action: 'conflict',
        group,
        existing: namedProduct,
      });
      return;
    }

    const existing = codedProduct || namedProduct;

    if (!existing) {
      if (categoryAction?.action === 'conflict') {
        actions.set(group.productCode, { action: 'conflict', group });
      } else {
        actions.set(group.productCode, { action: 'create', group });
      }
      return;
    }

    actions.set(group.productCode, {
      group,
      ...compareExistingProduct({
        existing,
        group,
        categoryAction,
        state,
      }),
    });
  });

  return actions;
};

const getVariantActions = async (groups, productActions, state) => {
  const allSkus = groups.flatMap(({ variants }) =>
    variants.map(({ sku }) => sku),
  );
  const existingProductIds = [...productActions.values()]
    .map(({ existing }) => existing?._id)
    .filter(Boolean);
  const existingVariants =
    allSkus.length === 0
      ? []
      : await ProductVariant.find({
          $or: [
            { sku: { $in: allSkus } },
            ...(existingProductIds.length > 0
              ? [{ product: { $in: existingProductIds } }]
              : []),
          ],
        }).lean();
  const bySku = new Map(
    existingVariants.map((variant) => [variant.sku, variant]),
  );
  const byCombination = new Map(
    existingVariants.map((variant) => [
      variantCombinationKey(
        variant.product,
        variant.color,
        variant.sizeSet,
      ),
      variant,
    ]),
  );
  const actions = new Map();

  groups.forEach((group) => {
    const productAction = productActions.get(group.productCode);
    const expectedProductId = productAction?.existing?._id;

    group.variants.forEach((sourceVariant) => {
      if (productAction?.action === 'conflict') {
        actions.set(sourceVariant.sku, {
          action: 'conflict',
          group,
          sourceVariant,
        });
        return;
      }

      const skuVariant = bySku.get(sourceVariant.sku);
      const combinationVariant = expectedProductId
        ? byCombination.get(
            variantCombinationKey(
              expectedProductId,
              sourceVariant.color,
              sourceVariant.sizeSet,
            ),
          )
        : undefined;

      if (
        skuVariant &&
        combinationVariant &&
        objectIdString(skuVariant._id) !==
          objectIdString(combinationVariant._id)
      ) {
        addPlanError(
          state,
          [sourceVariant.rowNumber],
          'VARIANT_IDENTITY_CONFLICT',
          'sku',
          `SKU ${sourceVariant.sku} and its product/color/size combination belong to different variants`,
        );
        actions.set(sourceVariant.sku, {
          action: 'conflict',
          group,
          sourceVariant,
        });
        return;
      }

      const existing = skuVariant || combinationVariant;

      if (!existing) {
        if (productAction?.existing?.status === 'inactive') {
          addPlanError(
            state,
            [sourceVariant.rowNumber],
            'INACTIVE_PRODUCT_VARIANT_CREATE',
            'variant',
            `A new variant cannot be added to inactive product ${group.productCode}`,
          );
          actions.set(sourceVariant.sku, {
            action: 'conflict',
            group,
            sourceVariant,
          });
          return;
        }

        actions.set(sourceVariant.sku, {
          action: 'create',
          group,
          sourceVariant,
        });
        return;
      }

      const conflicts = [];

      if (
        !expectedProductId ||
        objectIdString(existing.product) !== objectIdString(expectedProductId)
      ) {
        conflicts.push('parent product');
      }

      if (existing.sku !== sourceVariant.sku) {
        conflicts.push('SKU');
      }

      if (existing.color !== sourceVariant.color) {
        conflicts.push('color');
      }

      if (existing.sizeSet !== sourceVariant.sizeSet) {
        conflicts.push('size set');
      }

      if (existing.status !== sourceVariant.status) {
        conflicts.push('status');
      }

      const updates = {};

      if (!existing.sourceProductCode) {
        updates.sourceProductCode = sourceVariant.sourceProductCode;
      } else if (existing.sourceProductCode !== sourceVariant.sourceProductCode) {
        conflicts.push('source product code');
      }

      const overrideUpdates = {};

      PRODUCT_ATTRIBUTE_FIELDS.forEach((field) => {
        const sourceValue = sourceVariant.attributeOverrides[field];

        if (!sourceValue) {
          return;
        }

        const existingValue = existing.attributeOverrides?.[field];

        if (!existingValue) {
          overrideUpdates[field] = sourceValue;
        } else if (!valuesMatch(existingValue, sourceValue)) {
          conflicts.push(`${field} override`);
        }
      });

      if (Object.keys(overrideUpdates).length > 0) {
        updates.attributeOverrides = overrideUpdates;
      }

      if (conflicts.length > 0) {
        addPlanError(
          state,
          [sourceVariant.rowNumber],
          'EXISTING_VARIANT_CONFLICT',
          'sku',
          `Existing SKU ${sourceVariant.sku} differs in: ${[
            ...new Set(conflicts),
          ].join(', ')}`,
        );
        actions.set(sourceVariant.sku, {
          action: 'conflict',
          existing,
          group,
          sourceVariant,
        });
        return;
      }

      actions.set(sourceVariant.sku, {
        action: Object.keys(updates).length > 0 ? 'update' : 'reuse',
        existing,
        group,
        sourceVariant,
        updates,
      });
    });
  });

  return actions;
};

const transactionCountsByVariant = async (variantIds) => {
  if (variantIds.length === 0) {
    return new Map();
  }

  const counts = await InventoryTransaction.aggregate([
    { $match: { variant: { $in: variantIds } } },
    { $group: { _id: '$variant', count: { $sum: 1 } } },
  ]);

  return new Map(
    counts.map(({ _id, count }) => [objectIdString(_id), count]),
  );
};

const transactionMatchesInitialStock = (transaction, sourceVariant) =>
  transaction.type === 'ADD' &&
  transaction.sku === sourceVariant.sku &&
  transaction.quantity === sourceVariant.initialStock &&
  transaction.toShelf === sourceVariant.shelf;

const getInventoryActions = async (groups, variantActions, state) => {
  const existingVariantIds = [...variantActions.values()]
    .map(({ existing }) => existing?._id)
    .filter(Boolean);
  const skus = groups.flatMap(({ variants }) =>
    variants.map(({ sku }) => sku),
  );
  const inventories =
    skus.length === 0
      ? []
      : await Inventory.find({
          $or: [
            { sku: { $in: skus } },
            ...(existingVariantIds.length > 0
              ? [{ variant: { $in: existingVariantIds } }]
              : []),
          ],
        }).lean();
  const bySku = new Map(inventories.map((inventory) => [inventory.sku, inventory]));
  const byVariant = new Map(
    inventories.map((inventory) => [
      objectIdString(inventory.variant),
      inventory,
    ]),
  );
  const operationKeys = groups
    .flatMap(({ variants }) => variants)
    .filter(({ initialStock }) => initialStock > 0)
    .map(({ sku, shelf }) => initialStockOperationKey(sku, shelf));
  const completedTransactions =
    operationKeys.length === 0
      ? []
      : await InventoryTransaction.find({
          operationKey: { $in: operationKeys },
        })
          .select('+operationKey')
          .lean();
  const transactionByOperation = new Map(
    completedTransactions.map((transaction) => [
      transaction.operationKey,
      transaction,
    ]),
  );
  const transactionCounts = await transactionCountsByVariant(
    existingVariantIds,
  );
  const inventoryActions = new Map();
  const stockActions = new Map();

  groups.forEach((group) => {
    group.variants.forEach((sourceVariant) => {
      const variantAction = variantActions.get(sourceVariant.sku);

      if (!variantAction || variantAction.action === 'conflict') {
        inventoryActions.set(sourceVariant.sku, {
          action: 'conflict',
          sourceVariant,
        });
        return;
      }

      const variantId = variantAction.existing?._id;
      const skuInventory = bySku.get(sourceVariant.sku);
      const variantInventory = variantId
        ? byVariant.get(objectIdString(variantId))
        : undefined;

      if (
        skuInventory &&
        variantInventory &&
        objectIdString(skuInventory._id) !== objectIdString(variantInventory._id)
      ) {
        addPlanError(
          state,
          [sourceVariant.rowNumber],
          'INVENTORY_IDENTITY_CONFLICT',
          'inventory',
          `SKU ${sourceVariant.sku} maps to conflicting inventory records`,
        );
        inventoryActions.set(sourceVariant.sku, {
          action: 'conflict',
          sourceVariant,
        });
        return;
      }

      const existing = skuInventory || variantInventory;

      if (
        existing &&
        (existing.sku !== sourceVariant.sku ||
          !variantId ||
          objectIdString(existing.variant) !== objectIdString(variantId))
      ) {
        addPlanError(
          state,
          [sourceVariant.rowNumber],
          'EXISTING_INVENTORY_CONFLICT',
          'inventory',
          `Existing inventory identity does not match SKU ${sourceVariant.sku}`,
        );
        inventoryActions.set(sourceVariant.sku, {
          action: 'conflict',
          existing,
          sourceVariant,
        });
        return;
      }

      inventoryActions.set(sourceVariant.sku, {
        action: existing ? 'reuse' : 'create',
        existing,
        sourceVariant,
      });

      if (sourceVariant.initialStock <= 0) {
        return;
      }

      const operationKey = initialStockOperationKey(
        sourceVariant.sku,
        sourceVariant.shelf,
      );
      const completedTransaction = transactionByOperation.get(operationKey);

      if (completedTransaction) {
        if (!transactionMatchesInitialStock(completedTransaction, sourceVariant)) {
          addPlanError(
            state,
            [sourceVariant.rowNumber],
            'INITIAL_STOCK_REPLAY_CONFLICT',
            'initialStock',
            `Opening stock for ${sourceVariant.sku} was previously imported with different data`,
          );
          stockActions.set(sourceVariant.sku, {
            action: 'conflict',
            sourceVariant,
            operationKey,
          });
          return;
        }

        stockActions.set(sourceVariant.sku, {
          action: 'reuse',
          sourceVariant,
          operationKey,
          transaction: completedTransaction,
        });
        return;
      }

      if (existing) {
        const hasStock =
          existing.totalQuantity !== 0 ||
          existing.availableQuantity !== 0 ||
          (existing.shelves || []).length > 0;
        const transactionCount =
          transactionCounts.get(objectIdString(existing.variant)) || 0;

        if (hasStock || transactionCount > 0) {
          addPlanError(
            state,
            [sourceVariant.rowNumber],
            'INITIAL_STOCK_WOULD_OVERWRITE_HISTORY',
            'initialStock',
            `Initial stock for ${sourceVariant.sku} cannot be applied because inventory or transaction history already exists`,
          );
          stockActions.set(sourceVariant.sku, {
            action: 'conflict',
            sourceVariant,
            operationKey,
          });
          return;
        }
      }

      stockActions.set(sourceVariant.sku, {
        action: 'initialize',
        sourceVariant,
        operationKey,
      });
    });
  });

  return { inventoryActions, stockActions };
};

const buildReconciliationPlan = async (parsed) => {
  const state = {
    errors: [...parsed.errors],
    errorCount: parsed.errorCount,
    errorsTruncated: parsed.errorsTruncated,
    invalidRows: new Set(parsed.invalidRowNumbers || []),
  };

  if (parsed.errorCount > 0) {
    return {
      state,
      categoryActions: new Map(),
      productActions: new Map(),
      variantActions: new Map(),
      inventoryActions: new Map(),
      stockActions: new Map(),
    };
  }

  const categoryActions = await getCategoryActions(parsed.groups, state);
  const productActions = await getProductActions(
    parsed.groups,
    categoryActions,
    state,
  );
  const variantActions = await getVariantActions(
    parsed.groups,
    productActions,
    state,
  );
  const { inventoryActions, stockActions } = await getInventoryActions(
    parsed.groups,
    variantActions,
    state,
  );

  return {
    state,
    categoryActions,
    productActions,
    variantActions,
    inventoryActions,
    stockActions,
  };
};

const publicCategoryAction = (action) => ({
  name: action.name,
  slug: action.slug,
  existingId: action.existing?._id,
});

const publicProductAction = (action) => ({
  productName: action.group.product.productName,
  productCode: action.group.productCode,
  rowNumbers: productRows(action.group),
  existingId: action.existing?._id,
  fieldsToAdd: Object.keys(action.updates || {}),
});

const publicVariantAction = (action) => ({
  sku: action.sourceVariant.sku,
  sourceProductCode: action.sourceVariant.sourceProductCode,
  productCode: action.group.productCode,
  color: action.sourceVariant.color,
  sizeSet: action.sourceVariant.sizeSet,
  row: action.sourceVariant.rowNumber,
  existingId: action.existing?._id,
  fieldsToAdd: Object.keys(action.updates || {}),
});

const publicInventoryAction = (action) => ({
  sku: action.sourceVariant.sku,
  row: action.sourceVariant.rowNumber,
  existingId: action.existing?._id,
});

const publicStockAction = (action) => ({
  sku: action.sourceVariant.sku,
  row: action.sourceVariant.rowNumber,
  shelf: action.sourceVariant.shelf,
  quantity: action.sourceVariant.initialStock,
});

const buildReport = ({
  parsed,
  plan,
  sampleSize,
  mode,
  applied = {},
}) => {
  const selectedGroups = Number.isInteger(sampleSize)
    ? parsed.groups.slice(0, sampleSize)
    : parsed.groups;
  const selectedProductCodes = new Set(
    selectedGroups.map(({ productCode }) => productCode),
  );
  const selectedSkus = new Set(
    selectedGroups.flatMap(({ variants }) =>
      variants.map(({ sku }) => sku),
    ),
  );
  const selectedCategoryNames = new Set(
    selectedGroups.map(({ product }) =>
      normalizeTextForComparison(product.categoryName),
    ),
  );
  const categoryActions = [...plan.categoryActions.values()].filter((action) =>
    selectedCategoryNames.has(normalizeTextForComparison(action.name)),
  );
  const productActions = [...plan.productActions.values()].filter((action) =>
    selectedProductCodes.has(action.group.productCode),
  );
  const variantActions = [...plan.variantActions.values()].filter((action) =>
    selectedSkus.has(action.sourceVariant.sku),
  );
  const inventoryActions = [...plan.inventoryActions.values()].filter(
    (action) => selectedSkus.has(action.sourceVariant.sku),
  );
  const stockActions = [...plan.stockActions.values()].filter((action) =>
    selectedSkus.has(action.sourceVariant.sku),
  );
  const hasFileLevelError = plan.state.errors.some(
    ({ row }) => !Number.isInteger(row) || row < 2,
  );
  const invalidRows = hasFileLevelError
    ? parsed.totalRows
    : plan.state.invalidRows.size;
  const validationPassed = plan.state.errorCount === 0;
  const byAction = (actions, actionName) =>
    actions.filter(({ action }) => action === actionName);
  const newCategories = byAction(categoryActions, 'create').map(
    publicCategoryAction,
  );
  const existingCategories = categoryActions
    .filter((action) => action.action === 'reuse')
    .map(publicCategoryAction);
  const newProducts = byAction(productActions, 'create').map(
    publicProductAction,
  );
  const existingProducts = productActions
    .filter((action) => ['reuse', 'update'].includes(action.action))
    .map(publicProductAction);
  const updatedProducts = byAction(productActions, 'update').map(
    publicProductAction,
  );
  const newVariants = byAction(variantActions, 'create').map(
    publicVariantAction,
  );
  const existingVariants = variantActions
    .filter((action) => ['reuse', 'update'].includes(action.action))
    .map(publicVariantAction);
  const updatedVariants = byAction(variantActions, 'update').map(
    publicVariantAction,
  );
  const newInventories = byAction(inventoryActions, 'create').map(
    publicInventoryAction,
  );
  const existingInventories = byAction(inventoryActions, 'reuse').map(
    publicInventoryAction,
  );
  const stockToInitialize = byAction(stockActions, 'initialize').map(
    publicStockAction,
  );
  const stockAlreadyInitialized = byAction(stockActions, 'reuse').map(
    publicStockAction,
  );
  const warnings = [
    ...parsed.warnings,
    {
      row: 1,
      field: 'sourceProductCode',
      code: 'SOURCE_PRODUCT_CODE_IS_VARIANT_REFERENCE',
      message:
        'Product Code is color-level in the client file, so it is preserved on ProductVariant; Product.productCode is derived from Product Name',
    },
  ].slice(0, MAX_ISSUES);

  return {
    mode,
    status: validationPassed
      ? mode === 'IMPORT'
        ? 'COMPLETED'
        : 'READY'
      : 'BLOCKED',
    formatVersion: FORMAT_VERSION,
    policyVersion: POLICY_VERSION,
    validationPassed,
    canImport: validationPassed,
    sampleMode: Number.isInteger(sampleSize),
    sampleSize: Number.isInteger(sampleSize) ? sampleSize : null,
    source: parsed.source,
    mapping: REPORT_MAPPING,
    summary: {
      totalRows: parsed.totalRows,
      validRows: Math.max(0, parsed.totalRows - invalidRows),
      invalidRows,
      selectedRows: selectedGroups.reduce(
        (total, group) => total + group.rows.length,
        0,
      ),
      newCategories: newCategories.length,
      existingCategories: existingCategories.length,
      createdCategories: applied.createdCategories || 0,
      newProducts: newProducts.length,
      existingProducts: existingProducts.length,
      updatedProducts: updatedProducts.length,
      createdProducts: applied.createdProducts || 0,
      newVariants: newVariants.length,
      existingVariants: existingVariants.length,
      updatedVariants: updatedVariants.length,
      createdVariants: applied.createdVariants || 0,
      newInventories: newInventories.length,
      existingInventories: existingInventories.length,
      createdInventories: applied.createdInventories || 0,
      stockToInitialize: stockToInitialize.reduce(
        (total, { quantity }) => total + quantity,
        0,
      ),
      stockInitialized: applied.stockInitialized || 0,
      stockAlreadyInitialized:
        stockAlreadyInitialized.reduce(
          (total, { quantity }) => total + quantity,
          0,
        ) + (applied.stockAlreadyInitialized || 0),
    },
    duplicateSkus: parsed.duplicateSkus,
    missingRequiredFields: parsed.missingRequiredFields,
    newCategories,
    existingCategories,
    newProducts,
    existingProducts,
    updatedProducts,
    newVariants,
    existingVariants,
    updatedVariants,
    newInventories,
    existingInventories,
    stockToInitialize,
    stockAlreadyInitialized,
    errors: plan.state.errors.slice(0, MAX_ISSUES),
    warnings,
    errorCount: plan.state.errorCount,
    warningCount: parsed.warningCount + 1,
    errorsTruncated: plan.state.errorsTruncated,
    warningsTruncated:
      parsed.warningsTruncated || parsed.warnings.length + 1 > MAX_ISSUES,
  };
};

const validateSampleSize = (sampleSize) => {
  if (
    sampleSize !== undefined &&
    (!Number.isSafeInteger(sampleSize) || sampleSize < 1 || sampleSize > 1000)
  ) {
    throw new ApiError(400, 'Sample size must be an integer from 1 to 1000');
  }
};

const createPlan = async (buffer, options = {}) => {
  validateSampleSize(options.sampleSize);
  const parsed = await parseCatalogWorkbook(buffer, options);
  const plan = await buildReconciliationPlan(parsed);
  return { parsed, plan };
};

const dryRunCatalogMigration = async (buffer, options = {}) => {
  const { parsed, plan } = await createPlan(buffer, options);

  return buildReport({
    parsed,
    plan,
    sampleSize: options.sampleSize,
    mode: 'DRY_RUN',
  });
};

const applyCatalogPlan = async ({
  parsed,
  plan,
  sampleSize,
  performedBy,
  applied = createAppliedCounts(),
}) => {
  const selectedGroups = Number.isInteger(sampleSize)
    ? parsed.groups.slice(0, sampleSize)
    : parsed.groups;
  const selectedCategoryNames = [
    ...new Set(
      selectedGroups.map(({ product }) =>
        normalizeTextForComparison(product.categoryName),
      ),
    ),
  ];
  for (const categoryName of selectedCategoryNames) {
    const action = plan.categoryActions.get(categoryName);

    if (action.action === 'create') {
      await categoryService.createCategory({
        name: action.name,
        slug: action.slug,
        status: 'active',
      });
      applied.createdCategories += 1;
    }
  }

  for (const group of selectedGroups) {
    const productAction = plan.productActions.get(group.productCode);
    const category = await Category.findOne({
      name: group.product.categoryName,
      status: 'active',
    })
      .collation(CATEGORY_COLLATION)
      .select('_id')
      .lean();

    if (!category) {
      throw new ApiError(
        409,
        `Active category ${group.product.categoryName} was not available during import`,
      );
    }

    let productId;

    if (productAction.action === 'create') {
      const result = await productService.createProductForMigration(
        {
          ...group.product,
          categoryId: category._id,
        },
        group.variants,
      );
      productId = result.product._id;
      applied.createdProducts += 1;
      applied.createdVariants += group.variants.length;
      applied.createdInventories += group.variants.length;
    } else {
      productId = productAction.existing._id;

      if (productAction.action === 'update') {
        await productService.enrichProductForMigration(
          productId,
          productAction.updates,
        );
      }

      for (const sourceVariant of group.variants) {
        const variantAction = plan.variantActions.get(sourceVariant.sku);

        if (variantAction.action === 'create') {
          await variantService.createVariantForMigration(
            productId,
            sourceVariant,
          );
          applied.createdVariants += 1;
          applied.createdInventories += 1;
        } else if (variantAction.action === 'update') {
          await variantService.enrichVariantForMigration(
            variantAction.existing._id,
            variantAction.updates,
          );
        }
      }
    }

    const currentVariants = await ProductVariant.find({
      product: productId,
      sku: { $in: group.variants.map(({ sku }) => sku) },
    });
    const variantsBySku = new Map(
      currentVariants.map((variant) => [variant.sku, variant]),
    );

    for (const sourceVariant of group.variants) {
      const inventoryAction = plan.inventoryActions.get(sourceVariant.sku);

      if (inventoryAction.action !== 'create') {
        continue;
      }

      const variant = variantsBySku.get(sourceVariant.sku);

      if (!variant) {
        throw new ApiError(
          500,
          `Variant ${sourceVariant.sku} was not available for inventory initialization`,
        );
      }

      const before = await Inventory.exists({ variant: variant._id });
      await inventoryService.ensureInventoryForVariant(variant);

      if (!before) {
        applied.createdInventories += 1;
      }
    }
  }

  const adjustments = selectedGroups
    .flatMap(({ variants }) => variants)
    .map((sourceVariant) => ({
      sourceVariant,
      action: plan.stockActions.get(sourceVariant.sku),
    }))
    .filter(({ action }) => action?.action === 'initialize')
    .map(({ sourceVariant, action }) => ({
      row: sourceVariant.rowNumber,
      sku: sourceVariant.sku,
      type: 'ADD',
      quantity: sourceVariant.initialStock,
      shelf: sourceVariant.shelf,
      operationKey: action.operationKey,
    }));

  if (adjustments.length > 0) {
    const result = await inventoryService.applyAdjustmentBatch(adjustments, {
      performedBy,
      referenceId: `CATALOG-MIGRATION-${parsed.source.contentHash.slice(0, 32)}`,
    });

    if (result.errors.length > 0) {
      throw new ApiError(
        409,
        'Initial inventory validation changed during catalog import',
        result.errors,
      );
    }

    applied.stockInitialized = result.applied.reduce(
      (total, { adjustment }) => total + adjustment.quantity,
      0,
    );
    const requestedStock = adjustments.reduce(
      (total, adjustment) => total + adjustment.quantity,
      0,
    );
    applied.stockAlreadyInitialized =
      requestedStock - applied.stockInitialized;
  }

  return applied;
};

const importCatalogMigration = async (buffer, options = {}) => {
  if (importInProgress) {
    throw new ApiError(
      409,
      'Another catalog migration import is already in progress',
    );
  }

  importInProgress = true;

  try {
    const { parsed, plan } = await createPlan(buffer, options);
    const preflightReport = buildReport({
      parsed,
      plan,
      sampleSize: options.sampleSize,
      mode: 'IMPORT',
    });

    if (!preflightReport.canImport) {
      return {
        statusCode: 422,
        message: 'Catalog migration validation failed; no changes were made',
        data: preflightReport,
      };
    }

    const applied = createAppliedCounts();

    try {
      await applyCatalogPlan({
        parsed,
        plan,
        sampleSize: options.sampleSize,
        performedBy: options.performedBy,
        applied,
      });
    } catch (error) {
      console.error('Catalog migration import failed during apply:', error.message);

      const report = buildReport({
        parsed,
        plan,
        sampleSize: options.sampleSize,
        mode: 'IMPORT',
        applied,
      });
      const isSafeClientConflict =
        error instanceof ApiError && error.statusCode >= 400 && error.statusCode < 500;
      const publicMessage = isSafeClientConflict
        ? error.message
        : 'Catalog migration stopped unexpectedly; completed natural-key records can be safely detected on rerun';

      report.status = 'PARTIAL_FAILED';
      report.canImport = false;
      report.errorCount += 1;

      if (report.errors.length < MAX_ISSUES) {
        report.errors.push({
          row: 1,
          field: 'import',
          code: 'IMPORT_APPLY_FAILED',
          message: publicMessage,
        });
      } else {
        report.errorsTruncated = true;
      }

      return {
        statusCode: isSafeClientConflict ? error.statusCode : 500,
        message: publicMessage,
        data: report,
      };
    }

    const report = buildReport({
      parsed,
      plan,
      sampleSize: options.sampleSize,
      mode: 'IMPORT',
      applied,
    });

    return {
      statusCode: 200,
      message: Number.isInteger(options.sampleSize)
        ? 'Catalog migration sample imported successfully'
        : 'Catalog migration imported successfully',
      data: report,
    };
  } finally {
    importInProgress = false;
  }
};

module.exports = {
  dryRunCatalogMigration,
  importCatalogMigration,
};
