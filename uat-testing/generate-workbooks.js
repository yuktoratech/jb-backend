const fs = require('node:fs');
const path = require('node:path');

const escapeXml = (value) => String(value)
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

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const zip = (files) => {
  const local = [];
  const central = [];
  let offset = 0;
  Object.entries(files).forEach(([name, contents]) => {
    const fileName = Buffer.from(name);
    const data = Buffer.from(contents);
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(fileName.length, 26);
    const record = Buffer.concat([localHeader, fileName, data]);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(fileName.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    local.push(record);
    central.push(Buffer.concat([centralHeader, fileName]));
    offset += record.length;
  });
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
};

const workbook = (sheetName, rows) => {
  const maxColumns = Math.max(...rows.map((row) => row.length));
  const sheetRows = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      if (value === undefined || value === null || value === '') return '';
      const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
      const style = rowIndex === 0 ? ' s="1"' : '';
      if (typeof value === 'number') return `<c r="${reference}"${style}><v>${value}</v></c>`;
      return `<c r="${reference}" t="inlineStr"${style}><is><t>${escapeXml(value)}</t></is></c>`;
    }).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');
  const columns = Array.from({ length: maxColumns }, (_, index) =>
    `<col min="${index + 1}" max="${index + 1}" width="22" customWidth="1"/>`).join('');
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'xl/styles.xml': '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font/><font><b/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${columns}</cols><sheetData>${sheetRows}</sheetData><autoFilter ref="A1:${columnName(maxColumns - 1)}${rows.length}"/></worksheet>`,
  });
};

const productHeaders = [
  'Product Name', 'Product Code', 'SKU', 'Category', 'Product title', 'Colour',
  'Size', 'MRP', 'Fit', 'Pattern/Wash', 'Fabric', 'Sleeves', 'Waist',
];
const inventoryHeaders = ['SKU', 'QTY', 'SHELF', 'ADJUSTMENT TYPE', 'TO SHELF'];

const files = {
  '01-product-import-valid.xlsx': workbook('Products', [
    productHeaders,
    ['UATTEE26', 'UATTEE26_UATBLACK', 'UATTEE26_UATBLACK_S-XL', 'UATTOPS', 'Local UAT tee black', 'UATBLACK', 'S-XL', 599, 'UATREGULAR', '', 'UATCOTTON', '', ''],
    ['UATTEE26', 'UATTEE26_UATNAVY', 'UATTEE26_UATNAVY_M-2XL', 'UATTOPS', 'Local UAT tee navy', 'UATNAVY', 'M-2XL', 599, 'UATREGULAR', '', 'UATCOTTON', '', ''],
    ['UATJEAN26', 'UATJEAN26_UATBLUE', 'UATJEAN26_UATBLUE_30-36', 'UATBOTTOMS', 'Local UAT jeans', 'UATBLUE', '30-36', 1299, 'UATSLIM', '', 'UATDENIM', '', ''],
  ]),
  '02-inventory-import-valid.xlsx': workbook('Inventory', [
    inventoryHeaders,
    ['UATTEE26_UATBLACK_S-XL', 10, 'A-01', 'ADD', ''],
    ['UATTEE26_UATBLACK_S-XL', 5, 'A-02', 'ADD', ''],
    ['UATTEE26_UATBLACK_S-XL', 3, 'A-01', 'TRANSFER', 'A-03'],
    ['UATTEE26_UATBLACK_S-XL', 2, 'A-02', 'REMOVE', ''],
    ['UATTEE26_UATNAVY_M-2XL', 8, 'B-01', 'ADD', ''],
    ['UATJEAN26_UATBLUE_30-36', 6, 'C-01', 'ADD', ''],
    ['UATJEAN26_UATBLUE_30-36', 2, 'C-01', 'TRANSFER', 'C-02'],
  ]),
  '03-product-import-invalid.xlsx': workbook('Invalid Products', [
    productHeaders,
    ['UAT BAD NAME', '', '', 'UATTOPS', 'Intentionally invalid', 'UATBLACK', 'S-XL', 0, 'UATREGULAR', '', 'UATCOTTON', '', ''],
  ]),
  '04-inventory-import-invalid.xlsx': workbook('Invalid Inventory', [
    inventoryHeaders,
    ['UNKNOWN_UAT_SKU', 1, 'Z-01', 'ADD', ''],
    ['UATTEE26_UATBLACK_S-XL', 0, 'A-01', 'ADD', ''],
    ['UATTEE26_UATBLACK_S-XL', 1, 'A-01', 'TRANSFER', 'A-01'],
    ['UATTEE26_UATNAVY_M-2XL', 2, 'B-01', 'ADD', ''],
    ['UATTEE26_UATNAVY_M-2XL', 2, 'B-01', 'ADD', ''],
  ]),
};

for (const [name, contents] of Object.entries(files)) {
  fs.writeFileSync(path.join(__dirname, name), contents);
}

console.log(`Generated ${Object.keys(files).length} UAT workbooks.`);
