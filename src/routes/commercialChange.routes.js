import express from 'express';
import { auth, requireRole } from '../middleware/auth.js';
import {
  getQueue,
  getSidebarCounts,
  getById,
  decide,
  cancel,
} from '../controllers/commercialChange.controller.js';

// Quick Disconnect inbox endpoints — SUPER_ADMIN only. The receive side
// (inbound from SAM) lives under /api/webhooks/sam and is signature-verified.

const router = express.Router();

router.use(auth);
router.use(requireRole('SUPER_ADMIN'));

router.get('/queue', getQueue);
router.get('/sidebar-counts', getSidebarCounts);
router.get('/:id', getById);
router.patch('/:id/decide', decide);
router.patch('/:id/cancel', cancel);

export default router;
