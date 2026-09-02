const storage = require('../../storage/objectStorage.service');

const presentImages = async (images = []) => Promise.all(
  [...images]
    .sort((left, right) => left.sortIndex - right.sortIndex)
    .map(async (image) => ({
      _id: image._id,
      objectKey: image.objectKey,
      originalFilename: image.originalFilename,
      contentType: image.contentType,
      size: image.size,
      sortIndex: image.sortIndex,
      altText: image.altText || '',
      createdAt: image.createdAt,
      url: await storage.getObjectUrl({ key: image.objectKey }),
    })),
);

const presentProductColour = async (record) => ({
  ...record,
  images: await presentImages(record.images),
});

module.exports = { presentImages, presentProductColour };
