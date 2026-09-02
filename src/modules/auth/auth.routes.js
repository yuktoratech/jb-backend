const express = require('express');

const authenticate = require('../../middleware/auth.middleware');
const validate = require('../../middleware/validate.middleware');
const { createRateLimiter } = require('../../middleware/rateLimit.middleware');
const authController = require('./auth.controller');
const { changePasswordSchema, forgotPasswordSchema, loginSchema, resetPasswordSchema } = require('./auth.validation');

const router = express.Router();

const loginLimiter = createRateLimiter({ name: 'login', maxEnv: 'AUTH_LOGIN_RATE_LIMIT_MAX', windowEnv: 'AUTH_LOGIN_RATE_LIMIT_WINDOW_MS', defaultMax: 10, defaultWindowMs: 900000 });
const forgotLimiter = createRateLimiter({ name: 'forgot-password', maxEnv: 'AUTH_FORGOT_RATE_LIMIT_MAX', windowEnv: 'AUTH_FORGOT_RATE_LIMIT_WINDOW_MS', defaultMax: 5, defaultWindowMs: 900000 });
const resetLimiter = createRateLimiter({ name: 'reset-password', maxEnv: 'AUTH_RESET_RATE_LIMIT_MAX', windowEnv: 'AUTH_RESET_RATE_LIMIT_WINDOW_MS', defaultMax: 5, defaultWindowMs: 900000 });

router.post('/login', loginLimiter, validate(loginSchema), authController.login);
router.post('/forgot-password', forgotLimiter, validate(forgotPasswordSchema), authController.forgotPassword);
router.post('/reset-password', resetLimiter, validate(resetPasswordSchema), authController.resetPassword);
router.post('/change-password', authenticate, validate(changePasswordSchema), authController.changePassword);
router.get('/me', authenticate, authController.getCurrentUser);

module.exports = router;
