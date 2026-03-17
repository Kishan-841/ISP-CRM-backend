import express from 'express';
import { auth } from '../middleware/auth.js';
import {
  getAccountsDashboard,
  getCustomerBillingTable,
  getAgeingReport,
  createCollectionCall,
  getCollectionCallHistory,
  getCollectionCallStats,
  getAllCollectionCalls,
  getBusinessOverview
} from '../controllers/accountsDashboard.controller.js';

const router = express.Router();

// All routes require authentication
router.use(auth);

// Get business overview (quotation, bills, collection) for admin dashboard
router.get('/business-overview', getBusinessOverview);

// Get main dashboard data (summary cards, trends, ACP, outstanding, ageing)
router.get('/', getAccountsDashboard);

// Get customer billing table with pagination and search
router.get('/customers', getCustomerBillingTable);

// Get detailed ageing report
router.get('/ageing-report', getAgeingReport);

// Collection call endpoints
router.post('/collection-calls', createCollectionCall);
router.get('/collection-calls/stats', getCollectionCallStats);
router.get('/collection-calls/:invoiceId', getCollectionCallHistory);

// Get all collection calls for call history page
router.get('/call-history', getAllCollectionCalls);

export default router;
