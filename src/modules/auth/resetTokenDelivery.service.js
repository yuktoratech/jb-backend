const { deliverPasswordResetEmail } = require('./smtpPasswordReset.provider');

let deliveryHandler = deliverPasswordResetEmail;

const deliverPasswordResetToken = (delivery) => deliveryHandler(delivery);

const setPasswordResetDeliveryHandler = (handler) => {
  if (typeof handler !== 'function') throw new TypeError('Password reset delivery handler must be a function');
  deliveryHandler = handler;
};

const resetPasswordResetDeliveryHandler = () => {
  deliveryHandler = deliverPasswordResetEmail;
};

module.exports = { deliverPasswordResetToken, resetPasswordResetDeliveryHandler, setPasswordResetDeliveryHandler };
