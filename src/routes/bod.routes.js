import { Router } from 'express';
import { auth, requireRole } from '../middleware/auth.js';
import {
  BOD_CREATOR_ROLES,
  BOD_ACCOUNTS_ROLES,
  searchActiveCustomers,
  createBod,
  listBods,
  accountsQueue,
  updateBod,
  cancelBod,
  sendBack,
  generateBill
} from '../controllers/bod.controller.js';

const router = Router();
router.use(auth);

// Creator side (BDM / TL / admins)
router.get('/customers', requireRole(...BOD_CREATOR_ROLES), searchActiveCustomers);
router.post('/', requireRole(...BOD_CREATOR_ROLES), createBod);
router.put('/:id', requireRole(...BOD_CREATOR_ROLES), updateBod);
router.post('/:id/cancel', requireRole(...BOD_CREATOR_ROLES), cancelBod);

// Accounts side
router.get('/accounts/queue', requireRole(...BOD_ACCOUNTS_ROLES), accountsQueue);
router.post('/:id/send-back', requireRole(...BOD_ACCOUNTS_ROLES), sendBack);
router.post('/:id/generate-bill', requireRole(...BOD_ACCOUNTS_ROLES), generateBill);

// Shared list (creators see own; accounts/admins see all)
router.get('/', requireRole(...new Set([...BOD_CREATOR_ROLES, ...BOD_ACCOUNTS_ROLES])), listBods);

export default router;
