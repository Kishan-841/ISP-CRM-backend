import { Router } from 'express';
import { customerAuth } from '../middleware/customerAuth.js';
import {
  getProfile,
  updateProfile,
  getPlan,
  getInvoices,
  getInvoiceDetail,
  getPayments,
  getBillingSummary,
  getComplaintRequests,
  getComplaintCategories,
  createComplaintRequest,
  uploadRequestAttachment,
  getEnquiries,
  submitEnquiry,
} from '../controllers/customer.controller.js';
import { uploadComplaintAttachments } from '../config/cloudinary.js';

const router = Router();

router.use(customerAuth);

router.get('/profile', getProfile);
router.patch('/profile', updateProfile);
router.get('/plan', getPlan);
router.get('/invoices', getInvoices);
router.get('/invoices/:id', getInvoiceDetail);
router.get('/payments', getPayments);
router.get('/billing-summary', getBillingSummary);
router.get('/complaints', getComplaintRequests);
router.get('/complaints/categories', getComplaintCategories);
router.post('/complaints', createComplaintRequest);
router.post('/complaints/:id/attachments', uploadComplaintAttachments.array('files', 5), uploadRequestAttachment);
router.get('/enquiries', getEnquiries);
router.post('/enquiries', submitEnquiry);

export default router;
