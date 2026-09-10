const ProductColour = require('../productColours/productColour.model');
const SizeSet = require('../sizeSets/sizeSet.model');
const { canonicalizeSizeSet, sameCanonicalSizes } = require('../sizeSets/sizeSetCanonical');
const { generateProductCodeBase } = require('../../utils/sku');
const ApiError = require('../../utils/ApiError');

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const allocateProductCode = async ({ productId, colourId, productName, colourName, session, reserved = new Set() }) => {
  const logical = productId ? await ProductColour.findOne({ product: productId, colour: colourId }).session(session || null).lean() : null;
  if (logical) return logical.productCode;
  const base = generateProductCodeBase(productName, colourName);
  const records = await ProductColour.find({ productCode: { $regex: `^${escapeRegex(base)}(?:_[2-9][0-9]*)?$` } }).select('productCode').session(session || null).lean();
  const used = new Set([...records.map(({ productCode }) => productCode), ...reserved]);
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new ApiError(409, `A Product Code could not be allocated for ${productName} / ${colourName}.`);
};

const resolveOrCreateSizeSet = async ({ input, sizeFamily, session }) => {
  const canonical = canonicalizeSizeSet(input, sizeFamily);
  const existing = await SizeSet.findOne({ label: canonical.label }).collation({ locale: 'en', strength: 2 }).session(session || null);
  if (existing) {
    if (!sameCanonicalSizes(existing.sizes, canonical.sizes)) throw new ApiError(409, `Size ${canonical.label} conflicts with an existing Size Set.`);
    if (existing.status !== 'active') throw new ApiError(409, `Size ${canonical.label} is inactive. Activate it before continuing.`);
    return existing;
  }
  const [created] = await SizeSet.create([{ ...canonical, status: 'active' }], session ? { session } : undefined);
  return created;
};

module.exports = { allocateProductCode, resolveOrCreateSizeSet };
