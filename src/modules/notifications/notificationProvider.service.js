const firebaseProvider = require('./firebaseNotification.provider');

let provider = firebaseProvider;
const sendMulticast = (message) => provider.sendMulticast(message);
const setNotificationProvider = (nextProvider) => {
  if (!nextProvider || typeof nextProvider.sendMulticast !== 'function') {
    throw new TypeError('Notification provider must implement sendMulticast');
  }
  provider = nextProvider;
};
const resetNotificationProvider = () => { provider = firebaseProvider; };

module.exports = { resetNotificationProvider, sendMulticast, setNotificationProvider };
