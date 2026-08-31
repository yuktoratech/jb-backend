require('dotenv').config({ quiet: true });

const fs = require('fs/promises');
const path = require('path');
const mongoose = require('mongoose');

const USAGE =
  'node scripts/validateCatalogMigration.js <xlsx-file> [--sample-size N]\n' +
  '   or: node scripts/validateCatalogMigration.js --file <xlsx-file> [--sample-size N]';

class CliError extends Error {}

const readOptionValue = (args, index, optionName) => {
  const value = args[index + 1];

  if (!value || value.startsWith('--')) {
    throw new CliError(`${optionName} requires a value`);
  }

  return value;
};

const parseArguments = (args) => {
  let fileArgument;
  let sampleSize;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === '--file') {
      if (fileArgument) {
        throw new CliError('Specify the XLSX file only once');
      }

      fileArgument = readOptionValue(args, index, '--file');
      index += 1;
      continue;
    }

    if (argument.startsWith('--file=')) {
      if (fileArgument) {
        throw new CliError('Specify the XLSX file only once');
      }

      fileArgument = argument.slice('--file='.length);
      if (!fileArgument) {
        throw new CliError('--file requires a value');
      }
      continue;
    }

    if (argument === '--sample-size') {
      if (sampleSize !== undefined) {
        throw new CliError('Specify --sample-size only once');
      }

      sampleSize = readOptionValue(args, index, '--sample-size');
      index += 1;
      continue;
    }

    if (argument.startsWith('--sample-size=')) {
      if (sampleSize !== undefined) {
        throw new CliError('Specify --sample-size only once');
      }

      sampleSize = argument.slice('--sample-size='.length);
      if (!sampleSize) {
        throw new CliError('--sample-size requires a value');
      }
      continue;
    }

    if (argument.startsWith('-')) {
      throw new CliError(`Unknown option: ${argument}`);
    }

    if (fileArgument) {
      throw new CliError('Specify the XLSX file only once');
    }

    fileArgument = argument;
  }

  if (!fileArgument) {
    throw new CliError('An XLSX file path is required');
  }

  if (sampleSize !== undefined) {
    const parsedSampleSize = Number(sampleSize);

    if (!Number.isSafeInteger(parsedSampleSize) || parsedSampleSize <= 0) {
      throw new CliError('--sample-size must be a positive integer');
    }

    sampleSize = parsedSampleSize;
  }

  return {
    filePath: path.resolve(process.cwd(), fileArgument),
    sampleSize,
  };
};

const validationCannotProceed = (report) => {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return true;
  }

  const result =
    report.data && typeof report.data === 'object' && !Array.isArray(report.data)
      ? report.data
      : report;

  const negativeFlags = [
    result.success,
    result.valid,
    result.canProceed,
    result.canImport,
    result.canApply,
  ];

  if (negativeFlags.some((flag) => flag === false)) {
    return true;
  }

  const status = typeof result.status === 'string' ? result.status.toUpperCase() : '';
  return ['FAILED', 'BLOCKED', 'INVALID', 'PARTIAL_FAILED'].includes(status);
};

const toPublicErrorMessage = (error, filePath) => {
  if (['ENOENT', 'EACCES', 'EISDIR'].includes(error?.code)) {
    return 'Unable to read the specified XLSX file';
  }

  if (
    error?.name === 'MongooseServerSelectionError' ||
    error?.name === 'MongoServerSelectionError' ||
    error?.name === 'MongoNetworkError'
  ) {
    return 'Unable to connect to MongoDB';
  }

  let message = error?.message || 'Catalog migration validation failed';

  for (const sensitiveValue of [process.env.MONGODB_URI, filePath]) {
    if (sensitiveValue) {
      message = message.split(sensitiveValue).join('[redacted]');
    }
  }

  return message;
};

const printJson = (stream, value) => {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
};

const main = async () => {
  let filePath;
  let report;
  let commandError;

  try {
    const options = parseArguments(process.argv.slice(2));
    filePath = options.filePath;

    if (!process.env.MONGODB_URI) {
      throw new CliError('MONGODB_URI is required');
    }

    const buffer = await fs.readFile(filePath);
    const { dryRunCatalogMigration } = require('../src/modules/catalogMigration/catalogMigration.service');

    await mongoose.connect(process.env.MONGODB_URI);

    report = await dryRunCatalogMigration(buffer, {
      originalName: path.basename(filePath),
      sampleSize: options.sampleSize,
    });
  } catch (error) {
    commandError = error;
  } finally {
    try {
      await mongoose.disconnect();
    } catch (error) {
      commandError ||= new CliError('Unable to disconnect from MongoDB cleanly');
    }
  }

  if (commandError) {
    printJson(process.stderr, {
      success: false,
      message: toPublicErrorMessage(commandError, filePath),
      usage: USAGE,
    });
    process.exitCode = 1;
    return;
  }

  printJson(process.stdout, report);

  if (validationCannotProceed(report)) {
    process.exitCode = 1;
  }
};

main();
