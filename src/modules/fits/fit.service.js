const makeSimpleMasterService = require('../catalogMasters/simpleMaster.service');
const Fit = require('./fit.model');

module.exports = makeSimpleMasterService({ Model: Fit, singular: 'fit', plural: 'fits', indexPrefix: 'fit' });
