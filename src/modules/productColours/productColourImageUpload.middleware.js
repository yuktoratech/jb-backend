const multer = require('multer');
const ApiError = require('../../utils/ApiError');

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const maxBytes = () => {
  const parsed = Number(process.env.PRODUCT_IMAGE_MAX_BYTES);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 8 * 1024 * 1024;
};
const detectImage = (buffer) => {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { contentType: 'image/jpeg', extension: 'jpg' };
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { contentType: 'image/png', extension: 'png' };
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return { contentType: 'image/webp', extension: 'webp' };
  return null;
};
const uploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxBytes(), files: 1, fields: 1, parts: 3 },
  fileFilter(req, file, callback) {
    return ALLOWED_MIME.has(file.mimetype?.toLowerCase())
      ? callback(null, true)
      : callback(new ApiError(400, 'Only JPEG, PNG, and WebP images are allowed'));
  },
}).single('image');

module.exports = (req, res, next) => uploader(req, res, (error) => {
  if (error instanceof multer.MulterError) {
    return next(new ApiError(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
      error.code === 'LIMIT_FILE_SIZE' ? `Product image cannot exceed ${maxBytes()} bytes` : 'Upload exactly one image using the field name "image"'));
  }
  if (error) return next(error instanceof ApiError ? error : new ApiError(400, 'Invalid product image upload'));
  if (!req.file) return next(new ApiError(400, 'Product image is required in multipart field "image"'));
  const detected = detectImage(req.file.buffer);
  if (!detected || detected.contentType !== req.file.mimetype.toLowerCase()) return next(new ApiError(400, 'Uploaded content does not match an allowed image format'));
  req.detectedImage = detected;
  return next();
});

module.exports.detectImage = detectImage;
