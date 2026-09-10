const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');

const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.JWT_EXPIRES_IN = '1h';

const TEST_DATABASE_URI =
  process.env.INVENTORY_TEST_MONGODB_URI ||
  'mongodb://127.0.0.1:27017/jb_b2b_inventory_test';
const databaseName = new URL(TEST_DATABASE_URI).pathname.slice(1);

if (!/^jb_b2b_inventory_test(?:_|$)/.test(databaseName)) {
  throw new Error(
    'INVENTORY_TEST_MONGODB_URI must target a jb_b2b_inventory_test database',
  );
}

const app = require('../src/app');
const Category = require('../src/modules/categories/category.model');
const Inventory = require('../src/modules/inventory/inventory.model');
const InventoryTransaction = require('../src/modules/inventory/inventoryTransaction.model');
const productService = require('../src/modules/products/product.service');
const User = require('../src/modules/users/user.model');
const { generateAccessToken } = require('../src/utils/jwt');

const XLSX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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

const createXlsx = (rows) => {
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
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Inventory" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
  };
  return createStoredZip(files);
};

const closeServer = (server) =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

test('inventory APIs keep shelf stock and transaction history consistent', {
  timeout: 60000,
}, async () => {
  let server;

  try {
    await mongoose.connect(TEST_DATABASE_URI);
    await mongoose.connection.dropDatabase();

    const adminPassword = `Admin-${crypto.randomBytes(24).toString('base64url')}`;
    const retailerPassword = `Retailer-${crypto.randomBytes(24).toString('base64url')}`;
    const wholesalerPassword = `Wholesaler-${crypto.randomBytes(24).toString('base64url')}`;

    const [admin, wholesaler, category] = await Promise.all([
      User.create({
        name: 'Inventory Admin',
        email: 'inventory.admin@example.test',
        phone: '9000000001',
        password: adminPassword,
        role: 'admin',
        status: 'active',
        isEmailVerified: true,
      }),
      User.create({
        name: 'Inventory Wholesaler',
        email: 'inventory.wholesaler@example.test',
        phone: '9000000002',
        password: wholesalerPassword,
        role: 'wholesaler',
        status: 'active',
        isEmailVerified: true,
      }),
      Category.create({
        name: 'Inventory Test Category',
        status: 'active',
      }),
    ]);
    const retailer = await User.create({
      name: 'Inventory Retailer',
      email: 'inventory.retailer@example.test',
      phone: '9000000003',
      password: retailerPassword,
      role: 'retailer',
      status: 'active',
      isEmailVerified: true,
      parentWholesaler: wholesaler._id,
    });

    const productResult = await productService.createProductForMigration({
      productName: 'ABC',
      title: 'Inventory Test Product',
      categoryId: category._id.toString(),
      mrp: 100,
    }, [{ color: 'BLACK', sizeSet: '30-38', sku: 'ABC_BLACK_30-38' }]);
    const variant = productResult.variants[0].sizeSets[0];
    const variantId = variant.variantId.toString();

    assert.equal(variant.sku, 'ABC_BLACK_30-38');

    const zeroInventory = await Inventory.findOne({ variant: variantId }).lean();
    assert.ok(zeroInventory, 'product creation should initialize inventory');
    assert.equal(zeroInventory.availableQuantity, 0);

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
    const request = async (path, options = {}) => {
      const response = await fetch(`${baseUrl}${path}`, options);
      const body = await response.json();
      return { body, status: response.status };
    };

    const health = await request('/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.success, true);

    const login = await request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: admin.email,
        password: adminPassword,
      }),
    });
    assert.equal(login.status, 200);
    const authorization = `Bearer ${login.body.data.accessToken}`;

    const categories = await request('/categories', {
      headers: { Authorization: authorization },
    });
    const products = await request('/products', {
      headers: { Authorization: authorization },
    });
    assert.equal(categories.status, 200);
    assert.equal(products.status, 200);

    const retailerAccess = await request('/inventory', {
      headers: {
        Authorization: `Bearer ${generateAccessToken(retailer)}`,
      },
    });
    assert.equal(retailerAccess.status, 403);

    const unauthenticatedImport = await request('/inventory/imports/preview', {
      method: 'POST',
    });
    assert.equal(unauthenticatedImport.status, 401);

    const adjust = (body) =>
      request('/inventory/adjust', {
        method: 'POST',
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sku: variant.sku, ...body }),
      });

    let response = await adjust({ type: 'ADD', quantity: 10, shelf: 'a1' });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.inventory.availableQuantity, 10);

    response = await adjust({ type: 'ADD', quantity: 5, shelf: 'b2' });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.inventory.availableQuantity, 15);

    response = await adjust({
      type: 'TRANSFER',
      quantity: 4,
      shelf: 'A1',
      toShelf: 'B2',
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.inventory.availableQuantity, 15);

    response = await adjust({ type: 'REMOVE', quantity: 3, shelf: 'B2' });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.inventory.availableQuantity, 12);

    response = await adjust({ type: 'REMOVE', quantity: 20, shelf: 'B2' });
    assert.equal(response.status, 409);

    const detail = await request(`/inventory/${variantId}`, {
      headers: { Authorization: authorization },
    });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.availableQuantity, 12);
    assert.deepEqual(detail.body.data.shelves, [
      { shelf: 'A1', quantity: 6 },
      { shelf: 'B2', quantity: 6 },
    ]);

    const bySku = await request(`/inventory/sku/${variant.sku}`, {
      headers: { Authorization: authorization },
    });
    const inventoryList = await request('/inventory?stockStatus=in_stock', {
      headers: { Authorization: authorization },
    });
    assert.equal(bySku.status, 200);
    assert.equal(inventoryList.status, 200);
    assert.equal(inventoryList.body.data.pagination.total, 1);

    const addedVariant = await request(
      `/products/${productResult.product._id.toString()}/variants`,
      {
        method: 'POST',
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ color: 'NAVY', sizeSet: '30-38' }),
      },
    );
    assert.equal(addedVariant.status, 400);
    assert.equal(await Inventory.countDocuments({}), 1);

    let history = await request(`/inventory/${variantId}/transactions`, {
      headers: { Authorization: authorization },
    });
    assert.equal(history.status, 200);
    assert.equal(history.body.data.pagination.total, 4);
    assert.deepEqual(
      history.body.data.transactions.map((transaction) => ({
        type: transaction.type,
        quantity: transaction.quantity,
        fromShelf: transaction.fromShelf || null,
        toShelf: transaction.toShelf || null,
        previousQuantity: transaction.previousQuantity,
        newQuantity: transaction.newQuantity,
        source: transaction.source,
      })),
      [
        {
          type: 'REMOVE',
          quantity: 3,
          fromShelf: 'B2',
          toShelf: null,
          previousQuantity: 15,
          newQuantity: 12,
          source: 'admin',
        },
        {
          type: 'TRANSFER',
          quantity: 4,
          fromShelf: 'A1',
          toShelf: 'B2',
          previousQuantity: 15,
          newQuantity: 15,
          source: 'admin',
        },
        {
          type: 'ADD',
          quantity: 5,
          fromShelf: null,
          toShelf: 'B2',
          previousQuantity: 10,
          newQuantity: 15,
          source: 'admin',
        },
        {
          type: 'ADD',
          quantity: 10,
          fromShelf: null,
          toShelf: 'A1',
          previousQuantity: 0,
          newQuantity: 10,
          source: 'admin',
        },
      ],
    );

    const originalTransactionCreate = InventoryTransaction.create;
    InventoryTransaction.create = async () => {
      throw new Error('Simulated transaction-history write failure');
    };

    try {
      const failedHistoryWrite = await adjust({
        type: 'ADD',
        quantity: 1,
        shelf: 'D5',
      });
      assert.equal(failedHistoryWrite.status, 500);
    } finally {
      InventoryTransaction.create = originalTransactionCreate;
    }

    const afterCompensation = await Inventory.findOne({
      variant: variantId,
    }).lean();
    assert.equal(afterCompensation.availableQuantity, 12);
    assert.equal(await InventoryTransaction.countDocuments(), 4);

    history = await request(`/inventory/${variantId}/transactions`, {
      headers: { Authorization: authorization },
    });
    assert.equal(history.body.data.pagination.total, 4);
    assert.equal(await InventoryTransaction.countDocuments(), 4);
  } finally {
    if (server) {
      await closeServer(server);
    }

    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  }
});
