import express from 'express';
import { auth, requireRole } from '../middleware/auth.js';
import {
  getProducts,
  getParentProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct
} from '../controllers/product.controller.js';

const router = express.Router();

// All routes require authentication
router.use(auth);

// Routes accessible by all authenticated users
router.get('/', getProducts);
router.get('/parents', getParentProducts); // For dropdown (root-level products only)
router.get('/:id', getProduct);

// Admin routes. Sales Director manages the product catalogue alongside
// Super Admin, including which BDMs each product is visible to.
router.post('/', requireRole('SUPER_ADMIN', 'SALES_DIRECTOR'), createProduct);
router.put('/:id', requireRole('SUPER_ADMIN', 'SALES_DIRECTOR'), updateProduct);
router.delete('/:id', requireRole('SUPER_ADMIN', 'SALES_DIRECTOR'), deleteProduct);

export default router;
