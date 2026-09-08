const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');
const service = require('./productImport.service');

const preview = asyncHandler(async (req, res) => {
  const data = await service.previewImport(req.file.buffer, { uploadedBy: req.user._id, originalFilename: req.file.originalname });
  res.status(201).json(new ApiResponse(201, data, 'Product Import preview created'));
});

const apply = asyncHandler(async (req, res) => {
  const data = await service.applyImport(req.validated.params.batchId, { performedBy: req.user._id });
  res.status(200).json(new ApiResponse(200, data, 'Product Import applied successfully'));
});

module.exports = { apply, preview };
