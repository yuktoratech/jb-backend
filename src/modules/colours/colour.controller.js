const makeSimpleMasterController = require('../catalogMasters/simpleMaster.controller');
const colourService = require('./colour.service');

module.exports = makeSimpleMasterController({
  service: colourService,
  label: 'Colour',
  pluralLabel: 'Colours',
});
