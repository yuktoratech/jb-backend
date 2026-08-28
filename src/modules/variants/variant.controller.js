const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const variantService = require('./variant.service');

const updateVariant = asyncHandler(async (req, res) => {
  const variant = await variantService.updateVariant(
    req.validated.params.id,
    req.validated.body,
  );

  res
    .status(200)
    .json(new ApiResponse(200, variant, 'Product variant updated successfully'));
});

const deleteVariant = asyncHandler(async (req, res) => {
  const variant = await variantService.deactivateVariant(
    req.validated.params.id,
  );

  res
    .status(200)
    .json(
      new ApiResponse(200, variant, 'Product variant deactivated successfully'),
    );
});

module.exports = { deleteVariant, updateVariant };
