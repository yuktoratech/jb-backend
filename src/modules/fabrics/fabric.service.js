const makeSimpleMasterService = require('../catalogMasters/simpleMaster.service');
const Fabric = require('./fabric.model');

module.exports = makeSimpleMasterService({
  Model: Fabric,
  singular: 'fabric',
  plural: 'fabrics',
  indexPrefix: 'fabric',
});
