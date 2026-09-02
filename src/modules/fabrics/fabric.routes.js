const makeSimpleMasterRouter = require('../catalogMasters/simpleMaster.routes');
const controller = require('./fabric.controller');
const validation = require('./fabric.validation');

module.exports = makeSimpleMasterRouter({ controller, validation });
