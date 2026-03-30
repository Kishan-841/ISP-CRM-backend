import { Router } from 'express';
import multer from 'multer';
import { auth, requireRole } from '../middleware/auth.js';

const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
import {
  // SAM HEAD endpoints
  getCustomersWithInvoices,
  getSAMExecutives,
  createSAMExecutive,
  toggleSAMExecutiveStatus,
  assignCustomerToSAM,
  reassignCustomer,
  bulkReassignCustomers,
  getSAMHeadDashboardStats,
  // SAM EXECUTIVE endpoints
  getMyAssignedCustomers,
  getCustomerDetails,
  getSAMExecutiveDashboardStats,
  // Meeting endpoints
  createMeeting,
  getMeetings,
  getMeetingById,
  updateMeeting,
  getMOMEmailPreview,
  sendMOMEmail,
  // Customer service details endpoints
  updateCustomerServiceDetails,
  getCustomerServiceDetails,
  // Visit tracking endpoints
  createVisit,
  getVisits,
  getVisitById,
  updateVisit,
  completeVisit,
  cancelVisit,
  getVisitStats,
  // Alerts and payment
  getContractRenewalAlerts,
  getCustomerPaymentSummary,
  // Communication endpoints
  createCommunication,
  getCommunications,
  getCommunicationById,
  updateCommunication,
  sendCommunication,
  deleteCommunication,
  getCommunicationTemplates,
  getBusinessImpact,
  getSAMLeadStats
} from '../controllers/sam.controller.js';

const router = Router();

// All routes require authentication
router.use(auth);

// ==================== SAM HEAD ROUTES ====================
// SAM_HEAD can view and manage all customer assignments

router.get(
  '/customers/invoiced',
  requireRole('SAM_HEAD', 'SUPER_ADMIN'),
  getCustomersWithInvoices
);

router.get(
  '/executives',
  requireRole('SAM_HEAD', 'SUPER_ADMIN'),
  getSAMExecutives
);

router.post(
  '/executives',
  requireRole('SAM_HEAD', 'SUPER_ADMIN'),
  createSAMExecutive
);

router.patch(
  '/executives/:id/toggle-status',
  requireRole('SAM_HEAD', 'SUPER_ADMIN'),
  toggleSAMExecutiveStatus
);

router.post(
  '/assign',
  requireRole('SAM_HEAD', 'SUPER_ADMIN'),
  assignCustomerToSAM
);

router.post(
  '/reassign/:customerId',
  requireRole('SAM_HEAD', 'SUPER_ADMIN'),
  reassignCustomer
);

router.post(
  '/bulk-reassign',
  requireRole('SAM_HEAD', 'SUPER_ADMIN'),
  bulkReassignCustomers
);

router.get(
  '/head/dashboard',
  requireRole('SAM_HEAD', 'SUPER_ADMIN'),
  getSAMHeadDashboardStats
);

// Business Impact - accessible by SAM_HEAD, SAM_EXECUTIVE, SAM, SUPER_ADMIN
router.get(
  '/business-impact',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SAM', 'SUPER_ADMIN'),
  getBusinessImpact
);

// ==================== SAM EXECUTIVE ROUTES ====================
// SAM_EXECUTIVE can only see their assigned customers and manage their own meetings

router.get(
  '/my-customers',
  requireRole('SAM_EXECUTIVE'),
  getMyAssignedCustomers
);

router.get(
  '/executive/dashboard',
  requireRole('SAM_EXECUTIVE'),
  getSAMExecutiveDashboardStats
);

// ==================== SHARED ROUTES ====================
// Both SAM_HEAD (view all) and SAM_EXECUTIVE (view own) can access

router.get(
  '/customers/:customerId',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'),
  getCustomerDetails
);

// ==================== CUSTOMER SERVICE DETAILS ====================

// Get customer service details
router.get(
  '/customers/:customerId/service-details',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'),
  getCustomerServiceDetails
);

// Update customer service details
router.put(
  '/customers/:customerId/service-details',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'),
  updateCustomerServiceDetails
);

// Get customer payment summary (aging buckets)
router.get(
  '/customers/:customerId/payment-summary',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'),
  getCustomerPaymentSummary
);

// ==================== CONTRACT RENEWAL ALERTS ====================

router.get(
  '/alerts/contract-renewal',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'),
  getContractRenewalAlerts
);

// ==================== MEETING ROUTES ====================

// Get meetings - SAM_HEAD sees all, SAM_EXECUTIVE sees own
router.get(
  '/meetings',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'),
  getMeetings
);

// Get single meeting
router.get(
  '/meetings/:id',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'),
  getMeetingById
);

// Create meeting
router.post(
  '/meetings',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'),
  createMeeting
);

// Update MOM details
router.put(
  '/meetings/:id',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'),
  updateMeeting
);

// Get MOM email preview
router.post(
  '/meetings/:id/email-preview',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'),
  getMOMEmailPreview
);

// Send MOM email (with optional attachments)
router.post(
  '/meetings/:id/send-mom',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'),
  memoryUpload.array('attachments', 5),
  sendMOMEmail
);

// ==================== VISIT TRACKING ROUTES ====================

// Get visit statistics
router.get(
  '/visits/stats',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'),
  getVisitStats
);

// Get visits - SAM_HEAD sees all, SAM_EXECUTIVE sees own
router.get(
  '/visits',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'),
  getVisits
);

// Get single visit
router.get(
  '/visits/:id',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'),
  getVisitById
);

// Create visit - only SAM_EXECUTIVE
router.post(
  '/visits',
  requireRole('SAM_EXECUTIVE'),
  createVisit
);

// Update visit details (before visit)
router.put(
  '/visits/:id',
  requireRole('SAM_EXECUTIVE'),
  updateVisit
);

// Complete visit with outcome
router.post(
  '/visits/:id/complete',
  requireRole('SAM_EXECUTIVE'),
  completeVisit
);

// Cancel visit
router.post(
  '/visits/:id/cancel',
  requireRole('SAM_EXECUTIVE'),
  cancelVisit
);

// ==================== COMMUNICATION ROUTES ====================

// Get communication templates
router.get(
  '/communications/templates',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'),
  getCommunicationTemplates
);

// Get communications - SAM_HEAD sees all, SAM_EXECUTIVE sees own
router.get(
  '/communications',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'),
  getCommunications
);

// Get single communication
router.get(
  '/communications/:id',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'),
  getCommunicationById
);

// Create communication
router.post(
  '/communications',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'),
  createCommunication
);

// Update communication (drafts only)
router.put(
  '/communications/:id',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'),
  updateCommunication
);

// Send communication
router.post(
  '/communications/:id/send',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'),
  sendCommunication
);

// Delete communication (drafts only)
router.delete(
  '/communications/:id',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'),
  deleteCommunication
);

// SAM Lead Stats
router.get(
  '/lead-stats',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'),
  getSAMLeadStats
);

export default router;
