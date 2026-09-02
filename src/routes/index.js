const express = require('express');

const authRoutes = require('../modules/auth/auth.routes');
const addressRoutes = require('../modules/addresses/address.routes');
const catalogMigrationRoutes = require('../modules/catalogMigration/catalogMigration.routes');
const categoryRoutes = require('../modules/categories/category.routes');
const colourRoutes = require('../modules/colours/colour.routes');
const fabricRoutes = require('../modules/fabrics/fabric.routes');
const fitRoutes = require('../modules/fits/fit.routes');
const inventoryRoutes = require('../modules/inventory/inventory.routes');
const orderRoutes = require('../modules/orders/order.routes');
const productRoutes = require('../modules/products/product.routes');
const productColourRoutes = require('../modules/productColours/productColour.routes');
const retailerRoutes = require('../modules/retailers/retailer.routes');
const sizeSetRoutes = require('../modules/sizeSets/sizeSet.routes');
const subCategoryRoutes = require('../modules/subcategories/subCategory.routes');
const variantRoutes = require('../modules/variants/variant.routes');
const wholesalerRoutes = require('../modules/wholesalers/wholesaler.routes');

const router = express.Router();

router.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'API is running',
  });
});

router.use('/auth', authRoutes);
router.use('/addresses', addressRoutes);
router.use('/catalog-migrations', catalogMigrationRoutes);
router.use('/categories', categoryRoutes);
router.use('/colours', colourRoutes);
router.use('/fabrics', fabricRoutes);
router.use('/fits', fitRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/orders', orderRoutes);
router.use('/products', productRoutes);
router.use('/product-colours', productColourRoutes);
router.use('/retailers', retailerRoutes);
router.use('/size-sets', sizeSetRoutes);
router.use('/subcategories', subCategoryRoutes);
router.use('/variants', variantRoutes);
router.use('/wholesalers', wholesalerRoutes);

module.exports = router;
