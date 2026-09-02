const makeSimpleMasterController = require('../catalogMasters/simpleMaster.controller');
const service = require('./fit.service');

module.exports = makeSimpleMasterController({ service, label: 'Fit', pluralLabel: 'Fits' });
