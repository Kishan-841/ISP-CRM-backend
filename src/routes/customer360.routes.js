import { Router } from 'express';
import { auth, requireRole } from '../middleware/auth.js';
import {
  searchCustomers,
  exportCustomers,
  getSummary,
  getJourney,
  getBilling,
  getDocuments,
  downloadDocuments,
  getDocumentsReport,
  downloadAllDocuments,
  getComplaints,
  getSamActivity,
  getFeasibility
} from '../controllers/customer360.controller.js';

const router = Router();

router.use(auth);
router.use(requireRole('SUPER_ADMIN', 'SALES_DIRECTOR', 'OPS_TEAM'));

router.get('/search', searchCustomers);
router.get('/export', exportCustomers);
// Static routes MUST be registered before the /:id/* param routes below, or
// `/documents-report` would be captured as `/:id` = "documents-report".
router.get('/documents-report', getDocumentsReport);
router.get('/documents-report/download', downloadAllDocuments);
router.get('/:id/summary', getSummary);
router.get('/:id/journey', getJourney);
router.get('/:id/billing', getBilling);
router.get('/:id/documents', getDocuments);
router.get('/:id/documents/download', downloadDocuments);
router.get('/:id/complaints', getComplaints);
router.get('/:id/sam', getSamActivity);
router.get('/:id/feasibility', getFeasibility);

export default router;
