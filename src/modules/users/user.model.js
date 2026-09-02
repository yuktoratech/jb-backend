const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const {
  isValidPhone,
  normalizePhone,
} = require('./account.utils');

const PASSWORD_SALT_ROUNDS = 12;

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: [150, 'Name cannot exceed 150 characters'],
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      unique: true,
      maxlength: [254, 'Email cannot exceed 254 characters'],
    },
    phone: {
      type: String,
      set: normalizePhone,
      validate: {
        validator: isValidPhone,
        message: 'Phone must contain 7 to 15 digits with an optional leading +',
      },
    },
    password: {
      type: String,
      required: true,
      select: false,
    },
    passwordResetTokenHash: {
      type: String,
      select: false,
      match: /^[a-f\d]{64}$/,
    },
    passwordResetExpiresAt: {
      type: Date,
      select: false,
    },
    role: {
      type: String,
      enum: ['admin', 'wholesaler', 'retailer'],
      required: true,
      default: 'wholesaler',
    },
    status: {
      type: String,
      enum: ['active', 'inactive', 'pending', 'rejected'],
      default: 'pending',
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    lastLoginAt: {
      type: Date,
    },
    discountPercent: {
      type: Number,
      required: true,
      default: 0,
      min: [0, 'Discount percent cannot be less than 0'],
      max: [100, 'Discount percent cannot exceed 100'],
      validate: {
        validator: Number.isFinite,
        message: 'Discount percent must be a finite number',
      },
    },
    parentWholesaler: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      required() {
        return this.role === 'retailer';
      },
      validate: {
        validator: async function validateParentWholesaler(value) {
          if (this.role !== 'retailer') {
            return value === null || value === undefined;
          }

          if (!value) {
            return false;
          }

          const parentExists = await mongoose.model('User').exists({
            _id: value,
            role: 'wholesaler',
          });

          return Boolean(parentExists);
        },
        message:
          'Retailer must belong to a valid Wholesaler; other roles cannot have a parent Wholesaler',
      },
    },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
  },
);

const removePassword = (doc, returnedObject) => {
  delete returnedObject.password;
  delete returnedObject.passwordResetTokenHash;
  delete returnedObject.passwordResetExpiresAt;
  delete returnedObject.__v;
  return returnedObject;
};

userSchema.index(
  { role: 1, status: 1, createdAt: -1 },
  { name: 'users_by_role_status_created_at' },
);

userSchema.index(
  { parentWholesaler: 1, status: 1, createdAt: -1 },
  {
    name: 'retailers_by_parent_status_created_at',
    partialFilterExpression: { role: 'retailer' },
  },
);

userSchema.set('toJSON', { transform: removePassword });
userSchema.set('toObject', { transform: removePassword });

userSchema.pre('save', async function hashPassword() {
  if (!this.isModified('password')) {
    return;
  }

  this.password = await bcrypt.hash(this.password, PASSWORD_SALT_ROUNDS);
});

userSchema.methods.comparePassword = async function comparePassword(
  candidatePassword,
) {
  if (!this.password) {
    return false;
  }

  return bcrypt.compare(candidatePassword, this.password);
};

const User = mongoose.model('User', userSchema);

module.exports = User;
