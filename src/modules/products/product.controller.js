const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const variantService = require('../variants/variant.service');
const productService = require('./product.service');

const listProducts = asyncHandler(async (req, res) => {
  const data = await productService.listProducts(req.validated.query);

  res
    .status(200)
    .json(new ApiResponse(200, data, 'Products retrieved successfully'));
});

const createProduct = asyncHandler(async (req, res) => {
  const data = await productService.createProduct(req.validated.body);

  res
    .status(201)
    .json(new ApiResponse(201, data, 'Product created successfully'));
});

const getProduct = asyncHandler(async (req, res) => {
  const data = await productService.getProductById(req.validated.params.id);

  res
    .status(200)
    .json(new ApiResponse(200, data, 'Product retrieved successfully'));
});

const updateProduct = asyncHandler(async (req, res) => {
  const data = await productService.updateProduct(
    req.validated.params.id,
    req.validated.body,
  );

  res
    .status(200)
    .json(new ApiResponse(200, data, 'Product updated successfully'));
});

const deleteProduct = asyncHandler(async (req, res) => {
  const data = await productService.deactivateProduct(req.validated.params.id);

  res
    .status(200)
    .json(new ApiResponse(200, data, 'Product deactivated successfully'));
});

const listProductVariants = asyncHandler(async (req, res) => {
  const data = await variantService.listProductVariants(
    req.validated.params.id,
    req.validated.query,
  );

  res
    .status(200)
    .json(new ApiResponse(200, data, 'Product variants retrieved successfully'));
});

const createVariant = asyncHandler(async (req, res) => {
  const variant = await variantService.createVariant(
    req.validated.params.id,
    req.validated.body,
  );

  res
    .status(201)
    .json(new ApiResponse(201, variant, 'Product variant created successfully'));
});

module.exports = {
  createProduct,
  createVariant,
  deleteProduct,
  getProduct,
  listProducts,
  listProductVariants,
  updateProduct,
};
