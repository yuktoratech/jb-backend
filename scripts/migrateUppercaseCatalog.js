require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const mongoose = require('mongoose');
const { applyUppercaseCatalogMigration, buildUppercaseCatalogPlan } = require('../src/modules/catalogMigration/uppercaseCatalogMigration.service');

const main = async () => {
  const args = process.argv.slice(2); const apply = args.includes('--apply'); const mappingArg = args.find((entry) => entry.startsWith('--category-map='));
  if (args.some((entry) => entry !== '--apply' && !entry.startsWith('--category-map='))) throw new Error('Usage: node scripts/migrateUppercaseCatalog.js [--apply] [--category-map=/absolute/path.json]');
  if (apply && process.env.NODE_ENV === 'production') throw new Error('This migration cannot apply while NODE_ENV=production');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  const categorySizeFamilies = mappingArg ? JSON.parse(fs.readFileSync(mappingArg.slice('--category-map='.length), 'utf8')) : {};
  await mongoose.connect(process.env.MONGODB_URI);
  try { const report = apply ? await applyUppercaseCatalogMigration({ categorySizeFamilies }) : await buildUppercaseCatalogPlan({ categorySizeFamilies }); process.stdout.write(`${JSON.stringify({ ...report, updates: undefined }, null, 2)}\n`); }
  catch (error) { if (error.report) process.stderr.write(`${JSON.stringify(error.report, null, 2)}\n`); throw error; }
  finally { await mongoose.disconnect(); }
};
main().catch((error) => { process.stderr.write(`${JSON.stringify({ success: false, code: error.code || 'MIGRATION_FAILED', message: error.message })}\n`); process.exitCode = 1; });
