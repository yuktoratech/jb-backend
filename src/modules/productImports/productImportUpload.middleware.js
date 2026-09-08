const path = require('node:path');
const multer = require('multer');
const ApiError = require('../../utils/ApiError');
const { MAX_FILE_BYTES } = require('./productImport.constants');

const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 0, parts: 2 },
  fileFilter(req, file, callback) {
    const validExtension = path.extname(file.originalname).toLowerCase() === '.xlsx';
    const validMime = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream'].includes((file.mimetype || '').toLowerCase());
    callback(validExtension && validMime ? null : new ApiError(400, 'Only XLSX files are allowed'), validExtension && validMime);
  },
}).single('file');

module.exports = (req, res, next) => upload(req, res, (error) => {
  if (error) return next(error instanceof ApiError ? error : new ApiError(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400, error.code === 'LIMIT_FILE_SIZE' ? 'XLSX file cannot exceed 10 MiB' : 'Upload exactly one XLSX file using the field name "file"'));
  if (!req.file) return next(new ApiError(400, 'XLSX file is required in the multipart field "file"'));
  const buffer = req.file.buffer;
  if (!buffer || buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return next(new ApiError(400, 'The uploaded file is not a valid XLSX file'));
  return next();
});
