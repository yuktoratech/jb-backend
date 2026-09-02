const ApiResponse = require('../../utils/ApiResponse');
const asyncHandler = require('../../utils/asyncHandler');

const makeSimpleMasterController = ({ service, label, pluralLabel }) => ({
  list: asyncHandler(async (req, res) => {
    const data = await service.list(req.validated.query);
    res.status(200).json(new ApiResponse(200, data, `${pluralLabel} retrieved successfully`));
  }),
  create: asyncHandler(async (req, res) => {
    const data = await service.create(req.validated.body);
    res.status(201).json(new ApiResponse(201, data, `${label} created successfully`));
  }),
  get: asyncHandler(async (req, res) => {
    const data = await service.getById(req.validated.params.id);
    res.status(200).json(new ApiResponse(200, data, `${label} retrieved successfully`));
  }),
  update: asyncHandler(async (req, res) => {
    const data = await service.update(req.validated.params.id, req.validated.body);
    res.status(200).json(new ApiResponse(200, data, `${label} updated successfully`));
  }),
  deactivate: asyncHandler(async (req, res) => {
    const data = await service.deactivate(req.validated.params.id);
    res.status(200).json(new ApiResponse(200, data, `${label} deactivated successfully`));
  }),
});

module.exports = makeSimpleMasterController;
