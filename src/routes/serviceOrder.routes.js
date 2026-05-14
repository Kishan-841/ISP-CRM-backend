import { Router } from 'express';
import { auth, requireRole } from '../middleware/auth.js';
import {
  createServiceOrder,
  getServiceOrders,
  getServiceOrderById,
  approveServiceOrder,
  deliveryApproveServiceOrder,
  rejectServiceOrder,
  processServiceOrder,
  uploadOrderAttachment,
  getDisconnectionReasons,
  getDocsReviewQueue,
  docsReviewServiceOrder,
  getNocServiceOrderQueue,
  nocProcessServiceOrder,
  setActivationDate,
  accountsProcessServiceOrder,
} from '../controllers/serviceOrder.controller.js';
import { uploadOrderAttachments } from '../config/cloudinary.js';

const router = Router();

router.use(auth);

// Disconnection reason categories (must be before /:id)
router.get(
  '/disconnection-reasons',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'),
  getDisconnectionReasons
);

// List orders (role-based filtering inside controller)
router.get(
  '/',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN', 'ACCOUNTS_TEAM', 'NOC', 'DOCS_TEAM', 'SALES_DIRECTOR', 'DELIVERY_TEAM'),
  getServiceOrders
);

// Create order
router.post(
  '/',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'),
  createServiceOrder
);

// Docs review queue and disposition
router.get(
  '/docs-review/queue',
  requireRole('DOCS_TEAM', 'SUPER_ADMIN'),
  getDocsReviewQueue
);
router.post(
  '/:id/docs-review',
  requireRole('DOCS_TEAM', 'SUPER_ADMIN'),
  docsReviewServiceOrder
);

// NOC service order queue and processing
router.get(
  '/noc/queue',
  requireRole('NOC', 'NOC_HEAD', 'SUPER_ADMIN'),
  getNocServiceOrderQueue
);
router.post(
  '/:id/noc-process',
  requireRole('NOC', 'NOC_HEAD', 'SUPER_ADMIN'),
  uploadOrderAttachments.single('speedTest'),
  nocProcessServiceOrder
);

// Set activation date (SAM gets date from customer after NOC completes)
router.post(
  '/:id/set-activation-date',
  requireRole('SAM_EXECUTIVE', 'SAM_HEAD', 'SUPER_ADMIN'),
  setActivationDate
);

// Accounts processes order (applies plan change + starts billing)
router.post(
  '/:id/accounts-process',
  requireRole('ACCOUNTS_TEAM', 'SUPER_ADMIN'),
  accountsProcessServiceOrder
);

// Get single order (must be after static routes, before :id param routes)
router.get(
  '/:id',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN', 'ACCOUNTS_TEAM', 'NOC', 'DOCS_TEAM', 'SALES_DIRECTOR', 'DELIVERY_TEAM'),
  getServiceOrderById
);

// Delivery approval — first gate (UPGRADE/DOWNGRADE only)
router.post(
  '/:id/delivery-approve',
  requireRole('DELIVERY_TEAM', 'SUPER_ADMIN'),
  deliveryApproveServiceOrder
);

// Sales Director approval (replaces admin approval)
router.post(
  '/:id/approve',
  requireRole('SALES_DIRECTOR', 'SUPER_ADMIN'),
  approveServiceOrder
);

// Reject — accepted by either approving role at the early gates
router.post(
  '/:id/reject',
  requireRole('DELIVERY_TEAM', 'SALES_DIRECTOR', 'SUPER_ADMIN'),
  rejectServiceOrder
);

// Process order (mark completed)
router.post(
  '/:id/process',
  requireRole('ACCOUNTS_TEAM', 'NOC'),
  processServiceOrder
);

// Upload attachment
router.post(
  '/:id/upload',
  requireRole('SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN'),
  uploadOrderAttachments.single('file'),
  uploadOrderAttachment
);

export default router;
