const makeSimpleMasterRouter = require('../catalogMasters/simpleMaster.routes');
const controller = require('./fit.controller');
const validation = require('./fit.validation');

module.exports = makeSimpleMasterRouter({ controller, validation });
