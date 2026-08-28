const express = require('express');

const authenticate = require('../../middleware/auth.middleware');
const validate = require('../../middleware/validate.middleware');
const authController = require('./auth.controller');
const { loginSchema } = require('./auth.validation');

const router = express.Router();

router.post('/login', validate(loginSchema), authController.login);
router.get('/me', authenticate, authController.getCurrentUser);

module.exports = router;
