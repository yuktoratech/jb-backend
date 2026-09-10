const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 20000;
const MAX_ISSUES = 1000;
const BATCH_TTL_DAYS = 7;

const FIELDS = {
  productName: { label: 'Product Name', aliases: ['PRODUCT NAME'], required: true },
  category: { label: 'Category', aliases: ['CATEGORY'], required: true },
  subCategory: { label: 'Sub-category', aliases: ['SUB-CATEGORY', 'SUBCATEGORY', 'SUB CATEGORY'] },
  fit: { label: 'Fit', aliases: ['FIT'], required: true },
  fabric: { label: 'Fabric', aliases: ['FABRIC'], required: true },
  description: { label: 'Description', aliases: ['DESCRIPTION', 'PRODUCT TITLE'] },
  mrpPerPiece: { label: 'MRP Per Piece', aliases: ['MRP PER PIECE', 'MRP'], required: true },
  colour: { label: 'Colour', aliases: ['COLOUR', 'COLOR'], required: true },
  productCode: { label: 'Product Code', aliases: ['PRODUCT CODE'], required: true },
  sizeSet: { label: 'Size Set', aliases: ['SIZE SET', 'SIZE'], required: true },
  status: { label: 'Status', aliases: ['STATUS'] },
  suppliedSku: { label: 'SKU', aliases: ['SKU'], required: true },
  patternWash: { label: 'Pattern/Wash', aliases: ['PATTERN/WASH', 'PATTERN / WASH', 'PATTERN', 'WASH'] },
  sleeves: { label: 'Sleeves', aliases: ['SLEEVES', 'SLEEVE'] },
  waist: { label: 'Waist', aliases: ['WAIST'] },
  images: { label: 'Images', aliases: ['IMAGES', 'IMAGE', 'IMAGE URL', 'IMAGE URLS', 'PRODUCT IMAGE', 'PRODUCT IMAGES'] },
  initialStock: { label: 'Initial Stock', aliases: ['INITIAL STOCK', 'OPENING STOCK', 'STOCK', 'INVENTORY', 'QUANTITY', 'QTY'] },
  shelf: { label: 'Shelf', aliases: ['SHELF', 'SHELF CODE', 'BIN', 'BIN CODE', 'LOCATION'] },
};

module.exports = { BATCH_TTL_DAYS, FIELDS, MAX_FILE_BYTES, MAX_ISSUES, MAX_ROWS };
