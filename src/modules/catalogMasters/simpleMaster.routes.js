const express = require('express');
const authenticate = require('../../middleware/auth.middleware');
const authorize = require('../../middleware/authorize.middleware');
const validate = require('../../middleware/validate.middleware');

const makeSimpleMasterRouter = ({ controller, validation }) => {
  const router = express.Router();
  router.use(authenticate);
  router
    .route('/')
    .get(validate(validation.listSchema), controller.list)
    .post(authorize('admin'), validate(validation.createSchema), controller.create);
  router
    .route('/:id')
    .get(validate(validation.idSchema), controller.get)
    .patch(authorize('admin'), validate(validation.updateSchema), controller.update)
    .delete(authorize('admin'), validate(validation.idSchema), controller.deactivate);
  return router;
};

module.exports = makeSimpleMasterRouter;
