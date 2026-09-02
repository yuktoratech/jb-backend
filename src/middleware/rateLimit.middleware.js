const ApiError = require('../utils/ApiError');

const positiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const createRateLimiter = ({ maxEnv, windowEnv, defaultMax, defaultWindowMs, name }) => {
  const hits = new Map();
  const max = positiveInteger(process.env[maxEnv], defaultMax);
  const windowMs = positiveInteger(process.env[windowEnv], defaultWindowMs);

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + windowMs };
    entry.count += 1;
    hits.set(key, entry);
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.set('RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));
    if (hits.size > 10000) for (const [storedKey, stored] of hits) if (stored.resetAt <= now) hits.delete(storedKey);
    if (entry.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
      return next(new ApiError(429, `Too many ${name} requests; please try again later`));
    }
    return next();
  };
};

module.exports = { createRateLimiter };
