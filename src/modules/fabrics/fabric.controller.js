const makeSimpleMasterController = require('../catalogMasters/simpleMaster.controller');
const service = require('./fabric.service');

module.exports = makeSimpleMasterController({ service, label: 'Fabric', pluralLabel: 'Fabrics' });
