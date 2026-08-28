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

const loginSchema = {
  body: loginBodySchema,
};

module.exports = { loginSchema };
