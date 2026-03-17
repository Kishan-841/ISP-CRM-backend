import express from 'express';
import { auth } from '../middleware/auth.js';
import {
  getLedger,
  getBalance,
  checkReconciliation,
  runBackfill,
  getLedgerStatement
} from '../controllers/ledger.controller.js';

const router = express.Router();

// All routes require authentication
router.use(auth);

// Get customer ledger with all entries
router.get('/customer/:customerId', getLedger);

// Get customer current balance
router.get('/customer/:customerId/balance', getBalance);

// Get ledger statement (for print/download)
router.get('/customer/:customerId/statement', getLedgerStatement);

// Check reconciliation (optional customerId)
router.get('/reconciliation', checkReconciliation);
router.get('/reconciliation/:customerId', checkReconciliation);

// Backfill ledger from existing data (ADMIN ONLY)
router.post('/backfill', runBackfill);

export default router;
