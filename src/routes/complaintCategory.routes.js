import { Router } from 'express';
import { auth, requireRole } from '../middleware/auth.js';
import {
  getCategories,
  getAllCategories,
  createCategory,
  updateCategory,
  createSubCategory,
  updateSubCategory,
} from '../controllers/complaintCategory.controller.js';

const router = Router();

router.use(auth);

router.get('/', getCategories);

router.get('/all', requireRole('SUPER_ADMIN'), getAllCategories);
router.post('/', requireRole('SUPER_ADMIN'), createCategory);
router.put('/:id', requireRole('SUPER_ADMIN'), updateCategory);
router.post('/:id/sub-categories', requireRole('SUPER_ADMIN'), createSubCategory);
router.put('/sub-categories/:id', requireRole('SUPER_ADMIN'), updateSubCategory);

export default router;
