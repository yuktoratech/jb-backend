let deliveryHandler = async () => undefined;

const deliverPasswordResetToken = (delivery) => deliveryHandler(delivery);

const setPasswordResetDeliveryHandler = (handler) => {
  if (typeof handler !== 'function') throw new TypeError('Password reset delivery handler must be a function');
  deliveryHandler = handler;
};

const resetPasswordResetDeliveryHandler = () => {
  deliveryHandler = async () => undefined;
};

module.exports = { deliverPasswordResetToken, resetPasswordResetDeliveryHandler, setPasswordResetDeliveryHandler };
