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

// Admin only routes
router.post('/', requireRole('SUPER_ADMIN'), createProduct);
router.put('/:id', requireRole('SUPER_ADMIN'), updateProduct);
router.delete('/:id', requireRole('SUPER_ADMIN'), deleteProduct);

export default router;
