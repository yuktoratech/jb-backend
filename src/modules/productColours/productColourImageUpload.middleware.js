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
  limits: { fileSize: maxBytes(), files: 50, fields: 1, parts: 52 },
  fileFilter(req, file, callback) {
    if (!['image', 'images'].includes(file.fieldname)) {
      return callback(new ApiError(400, 'Upload images using multipart field "images".'));
    }
    return ALLOWED_MIME.has(file.mimetype?.toLowerCase())
      ? callback(null, true)
      : callback(new ApiError(400, 'Only JPEG, PNG, and WebP images are allowed'));
  },
}).any();

module.exports = (req, res, next) => uploader(req, res, (error) => {
  if (error instanceof multer.MulterError) {
    return next(new ApiError(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
      error.code === 'LIMIT_FILE_SIZE' ? 'Image file is too large.' : 'Upload up to 50 images using multipart field "images".'));
  }
  if (error) return next(error instanceof ApiError ? error : new ApiError(400, 'Invalid product image upload'));
  if (!req.files?.length) return next(new ApiError(400, 'At least one product image is required in multipart field "images".'));
  req.detectedImages = [];
  for (const file of req.files) {
    const detected = detectImage(file.buffer);
    if (!detected || detected.contentType !== file.mimetype.toLowerCase()) {
      return next(new ApiError(400, 'Unable to process this image.'));
    }
    req.detectedImages.push(detected);
  }
  return next();
});

module.exports.detectImage = detectImage;
