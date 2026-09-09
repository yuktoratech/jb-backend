require('dotenv').config();

const mongoose = require('mongoose');
const { z } = require('zod');

const connectDB = require('../src/config/db');
const User = require('../src/modules/users/user.model');

const adminEnvironmentVariables = [
  'ADMIN_NAME',
  'ADMIN_EMAIL',
  'ADMIN_PHONE',
  'ADMIN_PASSWORD',
];

const seedAdmin = async () => {
  const missingVariables = adminEnvironmentVariables.filter(
    (variableName) => !process.env[variableName]?.trim(),
  );

  if (missingVariables.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingVariables.join(', ')}`,
    );
  }

  const emailResult = z
    .string()
    .trim()
    .email()
    .transform((email) => email.toLowerCase())
    .safeParse(process.env.ADMIN_EMAIL);

  if (!emailResult.success) {
    throw new Error('ADMIN_EMAIL must be a valid email address');
  }

  const phoneResult = z
    .string()
    .trim()
    .min(1)
    .max(30)
    .transform((phone) => phone.replace(/[\s()-]/g, ''))
    .refine(
      (phone) => /^\+?[1-9]\d{6,14}$/.test(phone),
      'ADMIN_PHONE must contain 7 to 15 digits with an optional leading +',
    )
    .safeParse(process.env.ADMIN_PHONE);

  if (!phoneResult.success) {
    throw new Error(phoneResult.error.issues[0].message);
  }

  await connectDB();
  await User.init();

  const email = emailResult.data;
  const existingUser = await User.findOne({ email });

  if (existingUser) {
    if (existingUser.role !== 'admin') {
      throw new Error(
        'A non-admin user already uses ADMIN_EMAIL. Choose a different admin email.',
      );
    }

    if (!existingUser.phone) {
      const result = await User.updateOne(
        {
          _id: existingUser._id,
          $or: [{ phone: { $exists: false } }, { phone: null }, { phone: '' }],
        },
        { $set: { phone: phoneResult.data } },
        { runValidators: true },
      );
      if (result.modifiedCount !== 1) {
        throw new Error(
          'The Admin phone changed concurrently. No seed changes were made; rerun after reviewing the account.',
        );
      }
      console.log('Admin user already exists. Missing phone added from ADMIN_PHONE.');
      return;
    }

    console.log('Admin user already exists. No changes made.');
    return;
  }

  await User.create({
    name: process.env.ADMIN_NAME.trim(),
    email,
    phone: phoneResult.data,
    password: process.env.ADMIN_PASSWORD,
    role: 'admin',
    status: 'active',
    isEmailVerified: true,
  });

  console.log('Admin user created successfully.');
};

const run = async () => {
  try {
    await seedAdmin();
  } catch (error) {
    console.error('Admin seed failed:', error.message);
    process.exitCode = 1;
  } finally {
    if (mongoose.connection.readyState !== 0) {
      try {
        await mongoose.disconnect();
      } catch (error) {
        console.error('MongoDB disconnect failed:', error.message);
        process.exitCode = 1;
      }
    }
  }
};

run();
