import express from 'express';
import { auth, requireRole } from '../middleware/auth.js';
import {
  getInwardReport,
  getOutwardReport,
  getStockOnHandReport,
  getDamagedRejectedReport
} from '../controllers/storeReport.controller.js';

const router = express.Router();

router.use(auth);

const reportAccess = requireRole('STORE_MANAGER', 'ADMIN', 'SUPER_ADMIN');

router.get('/inward', reportAccess, getInwardReport);
router.get('/outward', reportAccess, getOutwardReport);
router.get('/stock-on-hand', reportAccess, getStockOnHandReport);
router.get('/damaged', reportAccess, getDamagedRejectedReport);

export default router;
