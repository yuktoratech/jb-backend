const { z } = require('zod');

const loginBodySchema = z.object({
  email: z
    .string({ error: 'Email is required' })
    .trim()
    .min(1, 'Email is required')
    .email('A valid email is required')
    .transform((email) => email.toLowerCase()),
  password: z
    .string({ error: 'Password is required' })
    .min(1, 'Password is required'),
});

const emailSchema = z.string({ error: 'Email is required' }).trim().min(1, 'Email is required').max(254).email('A valid email is required').transform((email) => email.toLowerCase());
const passwordSchema = z.string({ error: 'New password is required' })
  .min(8, 'New password must contain at least 8 characters')
  .max(128, 'New password cannot exceed 128 characters')
  .regex(/[a-z]/, 'New password must contain a lowercase letter')
  .regex(/[A-Z]/, 'New password must contain an uppercase letter')
  .regex(/\d/, 'New password must contain a number');

const forgotPasswordSchema = { body: z.object({ email: emailSchema }).strict() };
const resetPasswordSchema = { body: z.object({
  token: z.string({ error: 'Reset token is required' }).trim().regex(/^[a-f\d]{64}$/i, 'Reset token is malformed').transform((token) => token.toLowerCase()),
  newPassword: passwordSchema,
}).strict() };
const changePasswordSchema = { body: z.object({
  currentPassword: z.string({ error: 'Current password is required' }).min(1, 'Current password is required').max(128),
  newPassword: passwordSchema,
}).strict() };

const loginSchema = {
  body: loginBodySchema,
};

module.exports = { changePasswordSchema, forgotPasswordSchema, loginSchema, resetPasswordSchema };
