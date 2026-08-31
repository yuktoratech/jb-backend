const path = require('path');

const multer = require('multer');

const ApiError = require('../../utils/ApiError');

const MAX_XLSX_SIZE = 10 * 1024 * 1024;
const XLSX_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
]);

const uploader = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_XLSX_SIZE,
    files: 1,
    fields: 0,
    parts: 2,
  },
  fileFilter: (req, file, callback) => {
    const hasXlsxExtension =
      path.extname(file.originalname).toLowerCase() === '.xlsx';
    const hasAllowedMimeType = XLSX_MIME_TYPES.has(
      (file.mimetype || '').toLowerCase(),
    );

    if (!hasXlsxExtension || !hasAllowedMimeType) {
      return callback(new ApiError(400, 'Only XLSX files are allowed'));
    }

    return callback(null, true);
  },
}).single('file');

const hasZipSignature = (buffer) =>
  Buffer.isBuffer(buffer) &&
  buffer.length >= 4 &&
  buffer[0] === 0x50 &&
  buffer[1] === 0x4b &&
  ((buffer[2] === 0x03 && buffer[3] === 0x04) ||
    (buffer[2] === 0x05 && buffer[3] === 0x06) ||
    (buffer[2] === 0x07 && buffer[3] === 0x08));

const uploadCatalogMigration = (req, res, next) => {
  uploader(req, res, (error) => {
    if (error instanceof multer.MulterError) {
      const isUploadShapeError = [
        'LIMIT_UNEXPECTED_FILE',
        'LIMIT_FILE_COUNT',
        'LIMIT_FIELD_COUNT',
        'LIMIT_PART_COUNT',
      ].includes(error.code);
      const message =
        error.code === 'LIMIT_FILE_SIZE'
          ? 'XLSX file cannot exceed 10 MiB'
          : isUploadShapeError
            ? 'Upload exactly one XLSX file using the field name "file"'
            : 'Invalid catalog migration file upload';

      return next(
        new ApiError(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400, message),
      );
    }

    if (error) {
      return next(
        error instanceof ApiError
          ? error
          : new ApiError(400, 'Invalid catalog migration file upload'),
      );
    }

    if (!req.file) {
      return next(
        new ApiError(
          400,
          'XLSX file is required in the multipart field "file"',
        ),
      );
    }

    if (!hasZipSignature(req.file.buffer)) {
      return next(
        new ApiError(400, 'The uploaded file is not a valid XLSX file'),
      );
    }

    return next();
  });
};

module.exports = uploadCatalogMigration;
