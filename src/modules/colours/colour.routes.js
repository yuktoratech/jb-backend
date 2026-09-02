const makeSimpleMasterRouter = require('../catalogMasters/simpleMaster.routes');
const controller = require('./colour.controller');
const validation = require('./colour.validation');

module.exports = makeSimpleMasterRouter({ controller, validation });
