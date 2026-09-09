const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');

const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.JWT_EXPIRES_IN = '1h';

const TEST_DATABASE_URI =
  process.env.CATALOG_MIGRATION_TEST_MONGODB_URI ||
  'mongodb://127.0.0.1:27017/jb_b2b_catalog_migration_test';
const databaseName = new URL(TEST_DATABASE_URI).pathname.slice(1);

if (!/^jb_b2b_catalog_migration_test(?:_|$)/.test(databaseName)) {
  throw new Error(
    'CATALOG_MIGRATION_TEST_MONGODB_URI must target a jb_b2b_catalog_migration_test database',
  );
}

const app = require('../src/app');
const Category = require('../src/modules/categories/category.model');
const Inventory = require('../src/modules/inventory/inventory.model');
const inventoryService = require('../src/modules/inventory/inventory.service');
const InventoryTransaction = require('../src/modules/inventory/inventoryTransaction.model');
const Product = require('../src/modules/products/product.model');
const productService = require('../src/modules/products/product.service');
const User = require('../src/modules/users/user.model');
const ProductVariant = require('../src/modules/variants/productVariant.model');
const { generateAccessToken } = require('../src/utils/jwt');

const XLSX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const PRODUCT_HEADERS = Object.freeze([
  'Product Name',
  'Product Code',
  'SKU',
  'Category',
  'Product title',
  'Colour',
  'Size',
  'MRP',
  'Fit',
  'Pattern/Wash',
  'Fabric',
  'Sleeves',
  'Waist',
]);

const PRODUCT_ROWS = Object.freeze([
  Object.freeze([
    'ABC',
    'ABC_BLACK',
    'ABC_BLACK_30-38',
    'Jeans',
    'Men Loose-fit Jeans',
    'BLACK',
    '30-38',
    1299,
    'Loose-fit',
    'Solid',
    'Cotton',
    null,
    null,
  ]),
  Object.freeze([
    'ABC',
    'ABC_DBLUE',
    'ABC_DBLUE_30-36',
    'Jeans',
    'Men Loose-fit Jeans',
    'DBLUE',
    '30-36',
    1299,
    'Loose-fit',
    'Washed',
    'Cotton',
    null,
    null,
  ]),
  Object.freeze([
    'DEF',
    'DEF_RED',
    'DEF_RED_M-XL',
    'Shirts',
    "Men's Relaxed fit full sleeve shirt",
    'RED',
    'M-XL',
    1199,
    'Relaxed-fit',
    'Stripes',
    'Cotton',
    'Full-sleeve',
    null,
  ]),
  Object.freeze([
    'GEH',
    'GEH_BLACK',
    'GEH_BLACK_M-XL',
    'Shirts',
    "Men's Relaxed fit half sleeve shirt",
    'BLACK',
    'M-XL',
    1199,
    'Relaxed-fit',
    'Stripes',
    'Cotton',
    'Half-sleeve',
    null,
  ]),
]);

const VALUES_ROWS = Object.freeze([
  Object.freeze(['Category', 'Fit']),
  Object.freeze(['Jeans', 'Loose-fit']),
  Object.freeze(['Shirts', 'Relaxed-fit']),
  Object.freeze([null, 'Regular-fit']),
]);

const escapeXml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const columnName = (index) => {
  let value = index + 1;
  let name = '';

  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }

  return name;
};

const calculateCrc32 = (buffer) => {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
};

const createStoredZip = (files) => {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  Object.entries(files).forEach(([name, contents]) => {
    const fileName = Buffer.from(name);
    const data = Buffer.from(contents);
    const crc32 = calculateCrc32(data);
    const localHeader = Buffer.alloc(30);

    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(crc32, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(fileName.length, 26);

    const localRecord = Buffer.concat([localHeader, fileName, data]);
    const centralHeader = Buffer.alloc(46);

    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(crc32, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(fileName.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);

    localParts.push(localRecord);
    centralParts.push(Buffer.concat([centralHeader, fileName]));
    localOffset += localRecord.length;
  });

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);

  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(centralParts.length, 8);
  endRecord.writeUInt16LE(centralParts.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(localOffset, 16);

  return Buffer.concat([...localParts, centralDirectory, endRecord]);
};

const createWorksheetXml = (rows) => {
  const sheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          if (value === undefined || value === null || value === '') {
            return '';
          }

          const reference = `${columnName(columnIndex)}${rowIndex + 1}`;

          if (typeof value === 'number') {
            return `<c r="${reference}"><v>${value}</v></c>`;
          }

          return `<c r="${reference}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
        })
        .join('');

      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
};

const createTwoSheetXlsx = (productRows, productHeaders = PRODUCT_HEADERS) => {
  const files = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/><sheet name="Values" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': createWorksheetXml([
      productHeaders,
      ...productRows,
    ]),
    'xl/worksheets/sheet2.xml': createWorksheetXml(VALUES_ROWS),
  };

  return createStoredZip(files);
};

const cloneProductRows = () => PRODUCT_ROWS.map((row) => [...row]);

const closeServer = (server) =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

const parseJsonResponse = async (response) => {
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(
      `Expected JSON from ${response.url}, received: ${text.slice(0, 500)}`,
    );
  }
};

const responseDescription = (result) => JSON.stringify(result.body);

const normalizeMode = (mode) =>
  String(mode || '')
    .trim()
    .toLowerCase()
    .replaceAll('_', '-');

const toPlainObject = (value) =>
  value instanceof Map ? Object.fromEntries(value) : value || {};

const catalogCounts = async () => ({
  categories: await Category.countDocuments(),
  products: await Product.countDocuments(),
  variants: await ProductVariant.countDocuments(),
  inventories: await Inventory.countDocuments(),
  transactions: await InventoryTransaction.countDocuments(),
});

const totalDatabaseDocuments = async () => {
  const collections = await mongoose.connection.db
    .listCollections({}, { nameOnly: true })
    .toArray();
  const counts = await Promise.all(
    collections
      .filter(({ name }) => !name.startsWith('system.'))
      .map(({ name }) => mongoose.connection.db.collection(name).countDocuments()),
  );

  return counts.reduce((total, count) => total + count, 0);
};

const clearCatalog = async () => {
  await InventoryTransaction.deleteMany({});
  await Inventory.deleteMany({});
  await ProductVariant.deleteMany({});
  await Product.deleteMany({});
  await Category.deleteMany({});
};

test(
  'catalog migration dry-run, import, rerun, validation, and initial stock are safe',
  { timeout: 90000 },
  async () => {
    let server;

    try {
      await mongoose.connect(TEST_DATABASE_URI);
      await mongoose.connection.dropDatabase();

      const [admin, wholesaler] = await Promise.all([
        User.create({
          name: 'Catalog Migration Admin',
          email: 'catalog.migration.admin@example.test',
          phone: '9000000001',
          password: `Admin-${crypto.randomBytes(24).toString('base64url')}`,
          role: 'admin',
          status: 'active',
          isEmailVerified: true,
        }),
        User.create({
          name: 'Catalog Migration Wholesaler',
          email: 'catalog.migration.wholesaler@example.test',
          phone: '9000000002',
          password: `Wholesaler-${crypto.randomBytes(24).toString('base64url')}`,
          role: 'wholesaler',
          status: 'active',
          isEmailVerified: true,
        }),
      ]);
      const adminToken = generateAccessToken(admin);
      const wholesalerToken = generateAccessToken(wholesaler);

      server = app.listen(0, '127.0.0.1');
      await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });

      const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
      const uploadWorkbook = async (
        path,
        workbook,
        { token = adminToken, fileName = 'product-listing.xlsx' } = {},
      ) => {
        const form = new FormData();
        form.append(
          'file',
          new Blob([workbook], { type: XLSX_MIME_TYPE }),
          fileName,
        );
        const response = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: form,
        });

        return {
          body: await parseJsonResponse(response),
          status: response.status,
        };
      };

      const workbook = createTwoSheetXlsx(cloneProductRows());
      const documentsBeforeDryRun = await totalDatabaseDocuments();
      const dryRun = await uploadWorkbook(
        '/catalog-migrations/dry-run',
        workbook,
      );

      assert.equal(dryRun.status, 200, responseDescription(dryRun));
      assert.equal(dryRun.body.success, true);
      const dryRunReport = dryRun.body.data;
      assert.equal(normalizeMode(dryRunReport.mode), 'dry-run');
      assert.equal(dryRunReport.validationPassed, true);
      assert.equal(dryRunReport.canImport, true);
      assert.equal(dryRunReport.sampleMode, false);
      assert.equal(dryRunReport.summary.totalRows, 4);
      assert.equal(dryRunReport.summary.validRows, 4);
      assert.equal(dryRunReport.summary.invalidRows, 0);
      assert.equal(dryRunReport.summary.selectedRows, 4);
      assert.equal(dryRunReport.summary.newCategories, 2);
      assert.equal(dryRunReport.summary.newProducts, 3);
      assert.equal(dryRunReport.summary.newVariants, 4);
      assert.equal(dryRunReport.summary.newInventories, 4);
      assert.equal(dryRunReport.summary.createdCategories, 0);
      assert.equal(dryRunReport.summary.createdProducts, 0);
      assert.equal(dryRunReport.summary.createdVariants, 0);
      assert.equal(dryRunReport.summary.createdInventories, 0);
      assert.deepEqual(dryRunReport.duplicateSkus, []);
      assert.deepEqual(await catalogCounts(), {
        categories: 0,
        products: 0,
        variants: 0,
        inventories: 0,
        transactions: 0,
      });
      assert.equal(await totalDatabaseDocuments(), documentsBeforeDryRun);

      const sampledDryRun = await uploadWorkbook(
        '/catalog-migrations/dry-run?sampleSize=1',
        workbook,
      );
      assert.equal(
        sampledDryRun.status,
        200,
        responseDescription(sampledDryRun),
      );
      assert.equal(sampledDryRun.body.data.sampleMode, true);
      assert.equal(sampledDryRun.body.data.sampleSize, 1);
      assert.equal(sampledDryRun.body.data.summary.selectedRows, 2);
      assert.equal(sampledDryRun.body.data.summary.newCategories, 1);
      assert.equal(sampledDryRun.body.data.summary.newProducts, 1);
      assert.equal(sampledDryRun.body.data.summary.newVariants, 2);
      assert.equal(sampledDryRun.body.data.summary.newInventories, 2);
      assert.equal(await totalDatabaseDocuments(), documentsBeforeDryRun);

      const forbidden = await uploadWorkbook(
        '/catalog-migrations/dry-run',
        workbook,
        { token: wholesalerToken },
      );
      assert.equal(forbidden.status, 403, responseDescription(forbidden));
      assert.equal(await totalDatabaseDocuments(), documentsBeforeDryRun);

      const sampledImport = await uploadWorkbook(
        '/catalog-migrations/import?sampleSize=1',
        workbook,
      );
      assert.equal(
        sampledImport.status,
        200,
        responseDescription(sampledImport),
      );
      assert.equal(sampledImport.body.data.sampleMode, true);
      assert.equal(sampledImport.body.data.summary.selectedRows, 2);
      assert.equal(sampledImport.body.data.summary.createdCategories, 1);
      assert.equal(sampledImport.body.data.summary.createdProducts, 1);
      assert.equal(sampledImport.body.data.summary.createdVariants, 2);
      assert.equal(sampledImport.body.data.summary.createdInventories, 2);
      assert.deepEqual(await catalogCounts(), {
        categories: 1,
        products: 1,
        variants: 2,
        inventories: 2,
        transactions: 0,
      });
      assert.equal(await Product.countDocuments({ productCode: 'ABC' }), 1);

      await clearCatalog();

      const imported = await uploadWorkbook(
        '/catalog-migrations/import',
        workbook,
      );
      assert.equal(imported.status, 200, responseDescription(imported));
      assert.equal(imported.body.success, true);
      const importReport = imported.body.data;
      assert.equal(normalizeMode(importReport.mode), 'import');
      assert.equal(importReport.validationPassed, true);
      assert.equal(importReport.canImport, true);
      assert.equal(importReport.summary.createdCategories, 2);
      assert.equal(importReport.summary.createdProducts, 3);
      assert.equal(importReport.summary.createdVariants, 4);
      assert.equal(importReport.summary.createdInventories, 4);
      assert.equal(importReport.summary.stockInitialized, 0);
      assert.deepEqual(await catalogCounts(), {
        categories: 2,
        products: 3,
        variants: 4,
        inventories: 4,
        transactions: 0,
      });

      const products = await Product.find({}).sort({ productCode: 1 }).lean();
      assert.deepEqual(
        products.map(({ productCode }) => productCode),
        ['ABC', 'DEF', 'GEH'],
      );
      const abcProduct = products.find(({ productCode }) => productCode === 'ABC');
      assert.ok(abcProduct);
      assert.equal(abcProduct.productName, 'ABC');
      assert.equal(abcProduct.fit, 'Loose-fit');
      assert.equal(abcProduct.fabric, 'Cotton');
      assert.equal(abcProduct.mrp, 1299);
      assert.equal(abcProduct.patternWash, undefined);
      const jeansCategory = await Category.findById(abcProduct.category).lean();
      assert.equal(jeansCategory.name, 'Jeans');

      const abcVariants = await ProductVariant.find({ product: abcProduct._id })
        .sort({ sku: 1 })
        .lean();
      assert.equal(abcVariants.length, 2);
      const blackVariant = abcVariants.find(
        ({ sku }) => sku === 'abc_black_30-38',
      );
      const darkBlueVariant = abcVariants.find(
        ({ sku }) => sku === 'abc_dblue_30-36',
      );
      assert.ok(blackVariant);
      assert.ok(darkBlueVariant);
      assert.equal(blackVariant.sourceProductCode, 'abc_black');
      assert.equal(darkBlueVariant.sourceProductCode, 'abc_dblue');
      assert.equal(
        toPlainObject(blackVariant.attributeOverrides).patternWash,
        'Solid',
      );
      assert.equal(
        toPlainObject(darkBlueVariant.attributeOverrides).patternWash,
        'Washed',
      );

      const emptyInventories = await Inventory.find({}).lean();
      assert.equal(emptyInventories.length, 4);
      emptyInventories.forEach((inventory) => {
        assert.equal(inventory.totalQuantity, 0);
        assert.equal(inventory.availableQuantity, 0);
        assert.deepEqual(inventory.shelves, []);
      });

      const rerun = await uploadWorkbook(
        '/catalog-migrations/import',
        workbook,
      );
      assert.equal(rerun.status, 200, responseDescription(rerun));
      assert.equal(rerun.body.data.summary.createdCategories, 0);
      assert.equal(rerun.body.data.summary.createdProducts, 0);
      assert.equal(rerun.body.data.summary.createdVariants, 0);
      assert.equal(rerun.body.data.summary.createdInventories, 0);
      assert.equal(rerun.body.data.summary.existingCategories, 2);
      assert.equal(rerun.body.data.summary.existingProducts, 3);
      assert.equal(rerun.body.data.summary.existingVariants, 4);
      assert.equal(rerun.body.data.summary.existingInventories, 4);
      assert.deepEqual(await catalogCounts(), {
        categories: 2,
        products: 3,
        variants: 4,
        inventories: 4,
        transactions: 0,
      });

      const countsBeforeInvalidImport = await catalogCounts();
      const duplicateRows = cloneProductRows();
      duplicateRows[1][2] = duplicateRows[0][2];
      const duplicateImport = await uploadWorkbook(
        '/catalog-migrations/import',
        createTwoSheetXlsx(duplicateRows),
      );
      assert.equal(
        duplicateImport.status,
        422,
        responseDescription(duplicateImport),
      );
      assert.equal(duplicateImport.body.data.validationPassed, false);
      assert.equal(duplicateImport.body.data.canImport, false);
      assert.ok(duplicateImport.body.data.duplicateSkus.length > 0);
      assert.deepEqual(await catalogCounts(), countsBeforeInvalidImport);

      const missingSkuHeaders = PRODUCT_HEADERS.filter(
        (header) => header !== 'SKU',
      );
      const missingSkuRows = cloneProductRows().map((row) => [
        ...row.slice(0, 2),
        ...row.slice(3),
      ]);
      const missingRequiredImport = await uploadWorkbook(
        '/catalog-migrations/import',
        createTwoSheetXlsx(missingSkuRows, missingSkuHeaders),
      );
      assert.equal(
        missingRequiredImport.status,
        422,
        responseDescription(missingRequiredImport),
      );
      assert.equal(missingRequiredImport.body.data.validationPassed, false);
      assert.ok(missingRequiredImport.body.data.missingRequiredFields.length > 0);
      assert.deepEqual(await catalogCounts(), countsBeforeInvalidImport);

      await clearCatalog();
      const legacyCategory = await Category.create({
        name: 'Jeans',
        slug: 'jeans',
        status: 'active',
      });
      await productService.createProductForMigration({
        productName: 'ABC',
        productCode: 'ABC',
        title: 'Men Loose-fit Jeans',
        categoryId: legacyCategory._id.toString(),
        mrp: 1299,
      }, [
        { color: 'BLACK', sizeSet: '30-38', sku: 'ABC_BLACK_30-38' },
        { color: 'DBLUE', sizeSet: '30-36', sku: 'ABC_DBLUE_30-36' },
      ]);
      const enrichExisting = await uploadWorkbook(
        '/catalog-migrations/import?sampleSize=1',
        workbook,
      );
      assert.equal(
        enrichExisting.status,
        200,
        responseDescription(enrichExisting),
      );
      assert.equal(enrichExisting.body.data.summary.createdCategories, 0);
      assert.equal(enrichExisting.body.data.summary.createdProducts, 0);
      assert.equal(enrichExisting.body.data.summary.updatedProducts, 1);
      assert.equal(enrichExisting.body.data.summary.createdVariants, 0);
      assert.equal(enrichExisting.body.data.summary.updatedVariants, 2);
      assert.equal(enrichExisting.body.data.summary.createdInventories, 0);
      const enrichedProduct = await Product.findOne({ productCode: 'ABC' }).lean();
      assert.equal(enrichedProduct.fit, 'Loose-fit');
      assert.equal(enrichedProduct.fabric, 'Cotton');
      const enrichedVariants = await ProductVariant.find({
        product: enrichedProduct._id,
      }).lean();
      assert.deepEqual(
        enrichedVariants
          .map((variant) => ({
            sku: variant.sku,
            sourceProductCode: variant.sourceProductCode,
            patternWash: toPlainObject(variant.attributeOverrides).patternWash,
          }))
          .sort((left, right) => left.sku.localeCompare(right.sku)),
        [
          {
            sku: 'abc_black_30-38',
            sourceProductCode: 'abc_black',
            patternWash: 'Solid',
          },
          {
            sku: 'abc_dblue_30-36',
            sourceProductCode: 'abc_dblue',
            patternWash: 'Washed',
          },
        ],
      );

      await clearCatalog();
      const stockRows = cloneProductRows().map((row, index) => [
        ...row,
        index === 0 ? 5 : null,
        index === 0 ? 'MIG-A1' : null,
      ]);
      const stockWorkbook = createTwoSheetXlsx(stockRows, [
        ...PRODUCT_HEADERS,
        'Initial Stock',
        'Shelf',
      ]);
      const stockImport = await uploadWorkbook(
        '/catalog-migrations/import',
        stockWorkbook,
      );
      assert.equal(stockImport.status, 200, responseDescription(stockImport));
      assert.equal(stockImport.body.data.summary.createdCategories, 2);
      assert.equal(stockImport.body.data.summary.createdProducts, 3);
      assert.equal(stockImport.body.data.summary.createdVariants, 4);
      assert.equal(stockImport.body.data.summary.createdInventories, 4);
      assert.equal(stockImport.body.data.summary.stockToInitialize, 5);
      assert.equal(stockImport.body.data.summary.stockInitialized, 5);
      assert.equal(stockImport.body.data.summary.stockAlreadyInitialized, 0);

      const stockedVariant = await ProductVariant.findOne({
        sku: 'abc_black_30-38',
      }).lean();
      const stockedInventory = await Inventory.findOne({
        variant: stockedVariant._id,
      }).lean();
      assert.equal(stockedInventory.totalQuantity, 5);
      assert.equal(stockedInventory.availableQuantity, 5);
      assert.deepEqual(stockedInventory.shelves, [
        { shelf: 'MIG-A1', quantity: 5 },
      ]);
      const stockTransactions = await InventoryTransaction.find({
        variant: stockedVariant._id,
      }).lean();
      assert.equal(stockTransactions.length, 1);
      assert.equal(stockTransactions[0].type, 'ADD');
      assert.equal(stockTransactions[0].quantity, 5);
      assert.equal(stockTransactions[0].toShelf, 'MIG-A1');

      const stockRerun = await uploadWorkbook(
        '/catalog-migrations/import',
        stockWorkbook,
      );
      assert.equal(stockRerun.status, 200, responseDescription(stockRerun));
      assert.equal(stockRerun.body.data.summary.createdCategories, 0);
      assert.equal(stockRerun.body.data.summary.createdProducts, 0);
      assert.equal(stockRerun.body.data.summary.createdVariants, 0);
      assert.equal(stockRerun.body.data.summary.createdInventories, 0);
      assert.equal(stockRerun.body.data.summary.stockInitialized, 0);
      assert.equal(stockRerun.body.data.summary.stockAlreadyInitialized, 5);

      const inventoryAfterStockRerun = await Inventory.findOne({
        variant: stockedVariant._id,
      }).lean();
      assert.equal(inventoryAfterStockRerun.totalQuantity, 5);
      assert.equal(inventoryAfterStockRerun.availableQuantity, 5);
      assert.equal(
        await InventoryTransaction.countDocuments({
          variant: stockedVariant._id,
        }),
        1,
      );

      const liveVariant = await ProductVariant.findOne({
        sku: 'def_red_m-xl',
      }).lean();
      await inventoryService.adjustInventory(
        {
          sku: liveVariant.sku,
          type: 'ADD',
          quantity: 2,
          shelf: 'LIVE-A1',
        },
        { source: 'admin', performedBy: admin._id },
      );
      const conflictingStockRows = cloneProductRows().map((row, index) => [
        ...row,
        index === 0 ? 5 : index === 2 ? 4 : null,
        index === 0 ? 'MIG-A1' : index === 2 ? 'MIG-D1' : null,
      ]);
      const conflictingStockImport = await uploadWorkbook(
        '/catalog-migrations/import',
        createTwoSheetXlsx(conflictingStockRows, [
          ...PRODUCT_HEADERS,
          'Initial Stock',
          'Shelf',
        ]),
      );
      assert.equal(
        conflictingStockImport.status,
        422,
        responseDescription(conflictingStockImport),
      );
      assert.equal(conflictingStockImport.body.data.canImport, false);
      assert.ok(
        conflictingStockImport.body.data.errors.some(
          ({ code }) => code === 'INITIAL_STOCK_WOULD_OVERWRITE_HISTORY',
        ),
      );
      const liveInventory = await Inventory.findOne({
        variant: liveVariant._id,
      }).lean();
      assert.equal(liveInventory.totalQuantity, 2);
      assert.deepEqual(liveInventory.shelves, [
        { shelf: 'LIVE-A1', quantity: 2 },
      ]);
      assert.equal(
        await InventoryTransaction.countDocuments({ variant: liveVariant._id }),
        1,
      );
    } finally {
      if (server) {
        await closeServer(server);
      }

      if (mongoose.connection.readyState !== 0) {
        await mongoose.connection.dropDatabase();
        await mongoose.disconnect();
      }
    }
  },
);
