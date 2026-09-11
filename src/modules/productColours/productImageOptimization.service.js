const sharp = require('sharp');
const ApiError = require('../../utils/ApiError');

const MAX_DIMENSION = 1600;
const WEBP_QUALITY = 90;

const optimizeProductImage = async (buffer) => {
  try {
    const source = sharp(buffer, { failOn: 'error' });
    const metadata = await source.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format) || !metadata.width || !metadata.height) {
      throw new Error('Unsupported or unreadable image');
    }
    const output = await source
      .rotate()
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return {
      buffer: output.data,
      contentType: 'image/webp',
      extension: 'webp',
      width: output.info.width,
      height: output.info.height,
      size: output.info.size,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'Unable to process this image.');
  }
};

module.exports = { MAX_DIMENSION, WEBP_QUALITY, optimizeProductImage };
