require('dotenv').config({ quiet: true });

const mongoose = require('mongoose');
const { reconcileLegacyData } = require('../src/modules/dataReconciliation/dataReconciliation.service');

const main = async () => {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--apply') || args.filter((arg) => arg === '--apply').length > 1) {
    throw new Error('Usage: node scripts/reconcileLegacyData.js [--apply]');
  }
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const report = await reconcileLegacyData({ apply: args.includes('--apply') });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    if (error.report) process.stderr.write(`${JSON.stringify(error.report, null, 2)}\n`);
    throw error;
  } finally { await mongoose.disconnect(); }
};

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ success: false, code: error.code || 'MIGRATION_FAILED', message: error.message })}\n`);
  process.exitCode = 1;
});
