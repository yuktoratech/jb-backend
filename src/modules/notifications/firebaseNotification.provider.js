let messaging;

const getFirebaseMessaging = () => {
  if (messaging) return messaging;
  const { applicationDefault, cert, getApps, initializeApp } = require('firebase-admin/app');
  const { getMessaging } = require('firebase-admin/messaging');
  let app = getApps()[0];
  if (!app) {
    const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    const credential = encoded
      ? cert(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')))
      : applicationDefault();
    app = initializeApp({ credential, projectId: process.env.FIREBASE_PROJECT_ID || undefined });
  }
  messaging = getMessaging(app);
  return messaging;
};

const normalizeErrorCode = (error) => error?.code || error?.errorInfo?.code || 'messaging/unknown-error';

const sendMulticast = async ({ tokens, title, body, data }) => {
  const result = await getFirebaseMessaging().sendEachForMulticast({ tokens, notification: { title, body }, data });
  return {
    responses: result.responses.map((response) => response.success
      ? { success: true }
      : { success: false, errorCode: normalizeErrorCode(response.error) }),
  };
};

module.exports = { sendMulticast };
