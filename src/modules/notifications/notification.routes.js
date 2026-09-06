const express = require('express');
const authenticate = require('../../middleware/auth.middleware');
const validate = require('../../middleware/validate.middleware');
const controller = require('./deviceToken.controller');
const validation = require('./deviceToken.validation');

const router = express.Router();
router.use(authenticate);
router.post('/devices', validate(validation.registerDeviceSchema), controller.register);
router.delete('/devices/:id', validate(validation.deviceIdSchema), controller.unregister);

module.exports = router;
