import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import {
  createComplaint,
  getComplaints,
  getComplaintById,
  getMyQueue,
  getSidebarCounts,
  getDashboardStats,
  getCustomerComplaints,
  searchCustomers,
  getAssignableUsers,
  updateStatus,
  closeComplaint,
  assignComplaint,
  updateNotes,
  uploadAttachments,
  deleteAttachment,
  updateComplaintDetails,
  getCustomersWithComplaints,
} from '../controllers/complaint.controller.js';
import { uploadComplaintAttachments } from '../config/cloudinary.js';
import { getCustomerRequests, logComplaintFromRequest } from '../controllers/customer.controller.js';

const router = Router();

router.use(auth);

// Customer complaint requests (NOC-side)
router.get('/customer-requests', getCustomerRequests);
router.post('/customer-requests/:id/log', logComplaintFromRequest);

// List & Queue (specific routes before :id param routes)
router.get('/sidebar-counts', getSidebarCounts);
router.get('/my-queue', getMyQueue);
router.get('/dashboard/stats', getDashboardStats);
router.get('/search-customers', searchCustomers);
router.get('/assignable-users', getAssignableUsers);
router.get('/customers', getCustomersWithComplaints);
router.get('/customer/:leadId', getCustomerComplaints);
router.get('/', getComplaints);

// Create
router.post('/', createComplaint);

// Single complaint
router.get('/:id', getComplaintById);

// Status changes
router.put('/:id/status', updateStatus);
router.put('/:id/close', closeComplaint);
router.put('/:id/update-details', updateComplaintDetails);

// Assignment
router.put('/:id/assign', assignComplaint);

// Notes
router.put('/:id/notes', updateNotes);

// Attachments
router.post('/:id/attachments', uploadComplaintAttachments.array('files', 5), uploadAttachments);
router.delete('/:id/attachments/:attachmentId', deleteAttachment);

export default router;
