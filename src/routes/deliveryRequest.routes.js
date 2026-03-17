import express from 'express';
import { auth, requireRole } from '../middleware/auth.js';
import {
  // Delivery Team APIs
  createDeliveryRequest,
  getMyDeliveryRequests,
  getDeliveryRequestDetails,
  pushToNoc,

  // Approval APIs (Super Admin & Area Head)
  getPendingApprovalRequests,
  approveDeliveryRequest,
  rejectDeliveryRequest,
  getAllDeliveryRequests,

  // Store Manager APIs
  getApprovedRequestsForStore,
  assignItemsToRequest,
  markAsDispatched,
  markAsCompleted,
  getAvailableInventory,

  // NOC APIs
  getNocRequests,

  // Stats
  getDeliveryRequestStats
} from '../controllers/deliveryRequest.controller.js';

const router = express.Router();

// All routes require authentication
router.use(auth);

// ========== STATS (must be before :id) ==========
router.get('/stats/overview', auth, getDeliveryRequestStats);

// ========== DELIVERY TEAM ROUTES ==========
const deliveryTeamAccess = requireRole('DELIVERY_TEAM', 'SUPER_ADMIN');

// Create new delivery request
router.post('/create', deliveryTeamAccess, createDeliveryRequest);

// Get my delivery requests
router.get('/my-requests', deliveryTeamAccess, getMyDeliveryRequests);

// Push to NOC
router.post('/:id/push-to-noc', deliveryTeamAccess, pushToNoc);

// ========== NOC ROUTES ==========
const nocAccess = requireRole('NOC', 'SUPER_ADMIN');

// Get NOC requests
router.get('/noc/requests', nocAccess, getNocRequests);

// ========== APPROVAL ROUTES (Super Admin & Area Head) ==========
const approverAccess = requireRole('SUPER_ADMIN', 'AREA_HEAD');

// Get pending approval requests
router.get('/approval/pending', approverAccess, getPendingApprovalRequests);

// Get all requests (admin view)
router.get('/admin/all', requireRole('SUPER_ADMIN', 'ADMIN', 'AREA_HEAD'), getAllDeliveryRequests);

// Approve request
router.post('/approval/:id/approve', approverAccess, approveDeliveryRequest);

// Reject request
router.post('/approval/:id/reject', approverAccess, rejectDeliveryRequest);

// ========== STORE MANAGER ROUTES ==========
const storeAccess = requireRole('STORE_MANAGER', 'SUPER_ADMIN');

// Get approved requests for store manager
router.get('/store/approved', storeAccess, getApprovedRequestsForStore);

// Get available inventory for assignment
router.get('/store/inventory', storeAccess, getAvailableInventory);

// Assign items to request
router.post('/store/:id/assign', storeAccess, assignItemsToRequest);

// Mark as dispatched
router.post('/store/:id/dispatch', storeAccess, markAsDispatched);

// Mark as completed
router.post('/store/:id/complete', storeAccess, markAsCompleted);

// ========== SINGLE REQUEST DETAILS (must be last due to :id param) ==========
// Get single request details (accessible by all relevant roles)
router.get('/:id', auth, getDeliveryRequestDetails);

export default router;
