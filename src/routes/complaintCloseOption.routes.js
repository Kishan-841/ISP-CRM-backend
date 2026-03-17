import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import {
  getCloseOptions,
  getAllCloseOptions,
  createCloseOption,
  updateCloseOption,
} from '../controllers/complaintCloseOption.controller.js';

const router = Router();

router.use(auth);

router.get('/', getCloseOptions);
router.get('/all', getAllCloseOptions);
router.post('/', createCloseOption);
router.put('/:id', updateCloseOption);

export default router;
