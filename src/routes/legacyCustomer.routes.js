import express from 'express';
import { auth } from '../middleware/auth.js';
import {
  createSingle,
  createBulk,
  getTemplate,
  getDeliveryQueue,
  setDeliveryDate,
  getBillingQueue,
  setBilling,
  setFtb,
  listCustomers,
  getStats,
} from '../controllers/legacyCustomer.controller.js';

const router = express.Router();

// Accounts: create
router.get('/template', auth, getTemplate);
router.post('/single', auth, createSingle);
router.post('/bulk', auth, createBulk);

// Accounts: dashboard list + stats
router.get('/stats', auth, getStats);
router.get('/billing-queue', auth, getBillingQueue);

// Delivery: queue
router.get('/delivery-queue', auth, getDeliveryQueue);

// Accounts: list (keep last — generic root)
router.get('/', auth, listCustomers);

// Stage transitions
router.post('/:id/delivery', auth, setDeliveryDate);
router.post('/:id/billing', auth, setBilling);
router.post('/:id/ftb', auth, setFtb);

export default router;
