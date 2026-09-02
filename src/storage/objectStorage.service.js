const {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const booleanValue = (value) => String(value).toLowerCase() === 'true';
const positiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};
const requiredConfig = () => {
  const config = {
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
    bucket: process.env.S3_BUCKET,
  };
  const missing = Object.entries(config).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw new Error(`S3 storage is not configured: ${missing.join(', ')}`);
  return config;
};

let client;
const getClientAndConfig = () => {
  const config = requiredConfig();
  if (!client) client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: booleanValue(process.env.S3_FORCE_PATH_STYLE),
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  return { client, config };
};
const s3Adapter = {
  async uploadObject({ key, body, contentType }) {
    const state = getClientAndConfig();
    await state.client.send(new PutObjectCommand({ Bucket: state.config.bucket, Key: key, Body: body, ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable' }));
    return { key };
  },
  async deleteObject({ key }) {
    const state = getClientAndConfig();
    await state.client.send(new DeleteObjectCommand({ Bucket: state.config.bucket, Key: key }));
  },
  async getObjectUrl({ key }) {
    const publicBase = process.env.S3_PUBLIC_BASE_URL?.replace(/\/+$/, '');
    if (publicBase) return `${publicBase}/${key.split('/').map(encodeURIComponent).join('/')}`;
    const state = getClientAndConfig();
    return getSignedUrl(state.client, new GetObjectCommand({ Bucket: state.config.bucket, Key: key }), {
      expiresIn: positiveInteger(process.env.S3_SIGNED_URL_EXPIRES_SECONDS, 900),
    });
  },
};

let adapter = s3Adapter;
const uploadObject = (input) => adapter.uploadObject(input);
const deleteObject = (input) => adapter.deleteObject(input);
const getObjectUrl = (input) => adapter.getObjectUrl(input);
const setObjectStorageAdapter = (nextAdapter) => {
  if (!nextAdapter || ['uploadObject', 'deleteObject', 'getObjectUrl'].some((method) => typeof nextAdapter[method] !== 'function')) {
    throw new TypeError('Object storage adapter must implement uploadObject, deleteObject, and getObjectUrl');
  }
  adapter = nextAdapter;
};
const resetObjectStorageAdapter = () => { adapter = s3Adapter; client = undefined; };

module.exports = { deleteObject, getObjectUrl, resetObjectStorageAdapter, setObjectStorageAdapter, uploadObject };
