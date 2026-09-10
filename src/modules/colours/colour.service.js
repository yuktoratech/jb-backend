const makeSimpleMasterService = require('../catalogMasters/simpleMaster.service');
const Colour = require('./colour.model');

module.exports = makeSimpleMasterService({
  Model: Colour,
  singular: 'colour',
  plural: 'colours',
  indexPrefix: 'colour',
  normalizeName: (value) => value.trim().replace(/\s+/g, ' ').toUpperCase(),
});
