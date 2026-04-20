import express from 'express';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import { v2 as cloudinary } from 'cloudinary';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import prisma from '../config/db.js';
import {
  validateUploadToken,
  customerUploadDocument,
  customerRemoveDocument,
  customerCompleteUpload
} from '../controllers/publicUpload.controller.js';

const router = express.Router();

// Per-token rate limits for unauthenticated public routes. The route gate is
// the upload-link token (shared with the customer), so anyone with the URL
// can hit these endpoints — without these limits a leaked token could burn
// Cloudinary quota / storage indefinitely.
const tokenKeyGenerator = (req) => req.params?.token || req.ip;

const uploadRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,   // 10 min window
  max: 30,                     // 30 uploads per token per 10 min
  keyGenerator: tokenKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many uploads for this link. Please try again in a few minutes.' },
});

const tokenLookupRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000,     // 5 min window
  max: 60,                      // 60 other requests per token (validate, remove, complete)
  keyGenerator: tokenKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests for this link. Please wait a few minutes.' },
});

// Custom storage that gets leadId from token validation
const createCustomerStorage = () => {
  return new CloudinaryStorage({
    cloudinary: cloudinary,
    params: async (req, file) => {
      // leadId is set by middleware after token validation
      const leadId = req.leadId || 'unknown';
      const documentType = req.params.documentType || 'general';

      let resourceType = 'auto';
      if (file.mimetype === 'application/pdf' ||
          file.mimetype === 'application/msword' ||
          file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        resourceType = 'raw';
      }

      return {
        folder: `isp_crm/documents/${leadId}/${documentType}`,
        resource_type: resourceType,
        allowed_formats: ['jpg', 'jpeg', 'png', 'pdf', 'doc', 'docx'],
        public_id: `${Date.now()}-${file.originalname.replace(/\.[^/.]+$/, '')}`
      };
    }
  });
};

// File filter
const fileFilter = (req, file, cb) => {
  const allowedMimes = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only PDF, DOC, DOCX, JPG, and PNG files are allowed'), false);
  }
};

const customerUpload = multer({
  storage: createCustomerStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: fileFilter
});

// Middleware to validate token and set leadId on request
const validateTokenMiddleware = async (req, res, next) => {
  try {
    const { token } = req.params;

    const uploadLink = await prisma.documentUploadLink.findUnique({
      where: { token }
    });

    if (!uploadLink) {
      return res.status(404).json({ message: 'Invalid upload link' });
    }

    if (!uploadLink.isActive) {
      return res.status(410).json({ message: 'This upload link has been revoked' });
    }

    if (new Date() > new Date(uploadLink.expiresAt)) {
      return res.status(410).json({ message: 'This upload link has expired' });
    }

    // Set leadId on request for use by storage and controller
    req.leadId = uploadLink.leadId;
    req.uploadLink = uploadLink;

    next();
  } catch (error) {
    console.error('Token validation error:', error);
    res.status(500).json({ message: 'Failed to validate upload link' });
  }
};

// ==================== PUBLIC ROUTES (No Auth Required) ====================

// Validate upload token and get lead info
// GET /api/public/upload/:token
router.get('/:token', tokenLookupRateLimit, validateUploadToken);

// Upload document via customer link
// POST /api/public/upload/:token/document/:documentType
router.post(
  '/:token/document/:documentType',
  uploadRateLimit,
  validateTokenMiddleware,
  customerUpload.single('document'),
  customerUploadDocument
);

// Remove document via customer link
// DELETE /api/public/upload/:token/document/:documentType
router.delete(
  '/:token/document/:documentType',
  tokenLookupRateLimit,
  validateTokenMiddleware,
  customerRemoveDocument
);

// Mark upload as complete (sends notification to BDM)
// POST /api/public/upload/:token/complete
router.post('/:token/complete', tokenLookupRateLimit, validateTokenMiddleware, customerCompleteUpload);

export default router;
