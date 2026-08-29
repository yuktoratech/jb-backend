const crypto = require('crypto');

const TEMPORARY_PASSWORD_LENGTH = 16;
const UPPERCASE = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWERCASE = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%*_-';
const PASSWORD_ALPHABET = `${UPPERCASE}${LOWERCASE}${DIGITS}${SYMBOLS}`;
const PHONE_PATTERN = /^\+?[1-9]\d{6,14}$/;

const randomCharacter = (alphabet) =>
  alphabet[crypto.randomInt(0, alphabet.length)];

const generateTemporaryPassword = () => {
  const characters = [
    randomCharacter(UPPERCASE),
    randomCharacter(LOWERCASE),
    randomCharacter(DIGITS),
    randomCharacter(SYMBOLS),
  ];

  while (characters.length < TEMPORARY_PASSWORD_LENGTH) {
    characters.push(randomCharacter(PASSWORD_ALPHABET));
  }

  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(0, index + 1);
    [characters[index], characters[swapIndex]] = [
      characters[swapIndex],
      characters[index],
    ];
  }

  return characters.join('');
};

const normalizePhone = (value) => {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.trim().replace(/[\s()-]/g, '');
  return normalized || undefined;
};

const isValidPhone = (value) =>
  value === undefined || PHONE_PATTERN.test(value);

const toSafeAccount = (account) => {
  const source = account?.toObject ? account.toObject() : account;

  if (!source) {
    return null;
  }

  return {
    _id: source._id,
    name: source.name,
    email: source.email,
    phone: source.phone,
    role: source.role,
    status: source.status,
    isEmailVerified: source.isEmailVerified,
    lastLoginAt: source.lastLoginAt,
    discountPercent: source.discountPercent ?? 0,
    parentWholesaler: source.parentWholesaler ?? null,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
};

module.exports = {
  generateTemporaryPassword,
  isValidPhone,
  normalizePhone,
  toSafeAccount,
};
