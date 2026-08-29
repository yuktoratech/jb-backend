const express = require('express');

const authRoutes = require('../modules/auth/auth.routes');
const categoryRoutes = require('../modules/categories/category.routes');
const inventoryRoutes = require('../modules/inventory/inventory.routes');
const productRoutes = require('../modules/products/product.routes');
const retailerRoutes = require('../modules/retailers/retailer.routes');
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
router.use('/categories', categoryRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/products', productRoutes);
router.use('/retailers', retailerRoutes);
router.use('/variants', variantRoutes);
router.use('/wholesalers', wholesalerRoutes);

module.exports = router;
