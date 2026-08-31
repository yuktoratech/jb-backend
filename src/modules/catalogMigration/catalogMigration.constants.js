const FORMAT_VERSION = 'UNICOMMERCE_PRODUCT_LISTING_V1';
const POLICY_VERSION = 'CREATE_OR_ENRICH_MISSING_FIELDS_V1';
const MAX_IMPORT_ROWS = 20000;
const MAX_ISSUES = 1000;
const DEFAULT_INITIAL_SHELF = 'INITIAL';

const FIELD_DEFINITIONS = {
  productName: {
    label: 'Product Name',
    aliases: ['PRODUCT NAME', 'PRODUCT'],
    required: true,
  },
  sourceProductCode: {
    label: 'Product Code',
    aliases: ['PRODUCT CODE', 'ITEM CODE', 'STYLE COLOR CODE'],
    required: true,
  },
  sku: {
    label: 'SKU',
    aliases: ['SKU', 'SKU CODE', 'ITEM SKU'],
    required: true,
  },
  category: {
    label: 'Category',
    aliases: ['CATEGORY', 'CATEGORY NAME'],
    required: true,
  },
  title: {
    label: 'Product title',
    aliases: ['PRODUCT TITLE', 'TITLE', 'PRODUCT DESCRIPTION'],
    required: true,
  },
  color: {
    label: 'Colour',
    aliases: ['COLOUR', 'COLOR'],
    required: true,
  },
  sizeSet: {
    label: 'Size',
    aliases: ['SIZE', 'SIZE SET', 'SIZESET'],
    required: true,
  },
  mrp: {
    label: 'MRP',
    aliases: ['MRP', 'MAX RETAIL PRICE', 'MAXIMUM RETAIL PRICE'],
    required: true,
  },
  fit: {
    label: 'Fit',
    aliases: ['FIT'],
  },
  patternWash: {
    label: 'Pattern/Wash',
    aliases: ['PATTERN/WASH', 'PATTERN / WASH', 'PATTERN', 'WASH'],
  },
  fabric: {
    label: 'Fabric',
    aliases: ['FABRIC', 'MATERIAL'],
  },
  sleeves: {
    label: 'Sleeves',
    aliases: ['SLEEVES', 'SLEEVE'],
  },
  waist: {
    label: 'Waist',
    aliases: ['WAIST'],
  },
  description: {
    label: 'Description',
    aliases: ['DESCRIPTION', 'LONG DESCRIPTION'],
  },
  images: {
    label: 'Images',
    aliases: [
      'IMAGES',
      'IMAGE',
      'IMAGE URL',
      'IMAGE URLS',
      'PRODUCT IMAGE',
      'PRODUCT IMAGES',
      'IMAGE REFERENCE',
      'IMAGE REFERENCES',
    ],
  },
  status: {
    label: 'Status',
    aliases: ['STATUS', 'PRODUCT STATUS'],
  },
  initialStock: {
    label: 'Initial Stock',
    aliases: [
      'INITIAL STOCK',
      'OPENING STOCK',
      'STOCK',
      'INVENTORY',
      'QUANTITY',
      'QTY',
    ],
  },
  shelf: {
    label: 'Shelf',
    aliases: ['SHELF', 'SHELF CODE', 'BIN', 'BIN CODE', 'LOCATION'],
  },
};

const REQUIRED_FIELDS = Object.entries(FIELD_DEFINITIONS)
  .filter(([, definition]) => definition.required)
  .map(([field]) => field);

const PRODUCT_ATTRIBUTE_FIELDS = [
  'fit',
  'patternWash',
  'fabric',
  'sleeves',
  'waist',
];

const REPORT_MAPPING = {
  'Product Name': 'Product.productName and derived Product.productCode',
  'Product Code': 'ProductVariant.sourceProductCode',
  SKU: 'ProductVariant.sku',
  Category: 'Category.name / Product.category',
  'Product title': 'Product.title',
  Colour: 'ProductVariant.color',
  Size: 'ProductVariant.sizeSet',
  MRP: 'Product.mrp',
  Fit: 'Product.fit or ProductVariant.attributeOverrides.fit',
  'Pattern/Wash':
    'Product.patternWash or ProductVariant.attributeOverrides.patternWash',
  Fabric: 'Product.fabric or ProductVariant.attributeOverrides.fabric',
  Sleeves: 'Product.sleeves or ProductVariant.attributeOverrides.sleeves',
  Waist: 'Product.waist or ProductVariant.attributeOverrides.waist',
  Description: 'Product.description',
  Images: 'Product.images (deduplicated union)',
  Status: 'Product.status / ProductVariant.status',
  'Initial Stock': 'Inventory opening ADD transaction',
  Shelf: 'Inventory.shelves (defaults to INITIAL when stock is supplied)',
};

module.exports = {
  DEFAULT_INITIAL_SHELF,
  FIELD_DEFINITIONS,
  FORMAT_VERSION,
  MAX_IMPORT_ROWS,
  MAX_ISSUES,
  POLICY_VERSION,
  PRODUCT_ATTRIBUTE_FIELDS,
  REPORT_MAPPING,
  REQUIRED_FIELDS,
};
