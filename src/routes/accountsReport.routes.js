import express from 'express';
import { auth } from '../middleware/auth.js';
import {
  getAccountsReport,
  getDailyCollectionReport,
  getInvoiceReport,
  getOutstandingReport,
  getTaxReport,
  getCreditNoteReport,
  getBusinessImpactReport
} from '../controllers/accountsReport.controller.js';

const router = express.Router();

// All routes require authentication
router.use(auth);

// Get main accounts report with all metrics
router.get('/', getAccountsReport);

// Get daily collection report
router.get('/daily', getDailyCollectionReport);

// Get invoice report
router.get('/invoices', getInvoiceReport);

// Get outstanding report
router.get('/outstanding', getOutstandingReport);

// Get tax report (TDS)
router.get('/tax', getTaxReport);

// Get credit note report
router.get('/credit-notes', getCreditNoteReport);

// Get business impact report
router.get('/business-impact', getBusinessImpactReport);

export default router;
