import express from 'express';
import multer from 'multer';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import { cloudinary } from '../config/cloudinary.js';
import { auth, requireRole } from '../middleware/auth.js';
import {
  getVendors,
  getVendorById,
  createVendor,
  updateVendor,
  deleteVendor,
  getVendorStats,
  getPendingVendors,
  approveVendor,
  rejectVendor,
  createVendorFromFeasibility,
  uploadVendorDocs,
  verifyVendorDocs,
  getVendorApprovalQueue
} from '../controllers/vendor.controller.js';

const router = express.Router();

// Cloudinary storage for vendor documents
const vendorStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    let resourceType = 'auto';
    if (file.mimetype === 'application/pdf' ||
        file.mimetype === 'application/msword' ||
        file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      resourceType = 'raw';
    }
    return {
      folder: 'isp_crm/vendors',
      resource_type: resourceType,
      allowed_formats: ['jpg', 'jpeg', 'png', 'pdf'],
      public_id: `${Date.now()}-${file.originalname.replace(/\.[^/.]+$/, '')}`
    };
  }
});

const vendorUpload = multer({
  storage: vendorStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPG, PNG, and PDF files are allowed'), false);
    }
  }
});

// All routes require authentication
router.use(auth);

// Get all vendors (accessible by all authenticated users)
router.get('/', getVendors);

// Get vendor stats (admin + accounts)
router.get('/stats', requireRole('SUPER_ADMIN', 'ACCOUNTS_TEAM', 'FEASIBILITY_TEAM'), getVendorStats);

// Vendor approval queue (admin)
router.get('/approval-queue', requireRole('SUPER_ADMIN'), getVendorApprovalQueue);

// Get pending vendors for approval
router.get('/pending', requireRole('SUPER_ADMIN', 'ACCOUNTS_TEAM'), getPendingVendors);

// Get single vendor by ID
router.get('/:id', getVendorById);

// Create new vendor (with file uploads)
router.post(
  '/',
  requireRole('SUPER_ADMIN', 'ACCOUNTS_TEAM', 'FEASIBILITY_TEAM'),
  vendorUpload.fields([
    { name: 'panDocument', maxCount: 1 },
    { name: 'gstDocument', maxCount: 1 },
    { name: 'cancelledCheque', maxCount: 1 }
  ]),
  createVendor
);

// Update vendor (Admin only)
router.put('/:id', requireRole('SUPER_ADMIN'), updateVendor);

// Create vendor from feasibility (simplified, docs optional)
router.post(
  '/from-feasibility',
  requireRole('SUPER_ADMIN', 'FEASIBILITY_TEAM'),
  vendorUpload.fields([
    { name: 'panDocument', maxCount: 1 },
    { name: 'gstDocument', maxCount: 1 },
    { name: 'cancelledCheque', maxCount: 1 }
  ]),
  createVendorFromFeasibility
);

// Upload vendor documents (after initial creation)
router.post(
  '/:id/upload-docs',
  requireRole('SUPER_ADMIN', 'FEASIBILITY_TEAM'),
  vendorUpload.fields([
    { name: 'panDocument', maxCount: 1 },
    { name: 'gstDocument', maxCount: 1 },
    { name: 'cancelledCheque', maxCount: 1 }
  ]),
  uploadVendorDocs
);

// Verify vendor documents (accounts team)
router.post('/:id/verify-docs', requireRole('SUPER_ADMIN', 'ACCOUNTS_TEAM'), verifyVendorDocs);

// Approve vendor (admin only - accounts team uses verify-docs)
router.post('/:id/approve', requireRole('SUPER_ADMIN'), approveVendor);

// Reject vendor
router.post('/:id/reject', requireRole('SUPER_ADMIN', 'ACCOUNTS_TEAM'), rejectVendor);

// Delete vendor (Admin only)
router.delete('/:id', requireRole('SUPER_ADMIN'), deleteVendor);

export default router;
