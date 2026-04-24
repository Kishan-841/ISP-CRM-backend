import express from 'express';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import { v2 as cloudinary } from 'cloudinary';
import multer from 'multer';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import prisma from '../config/db.js';
import { sanitizePublicId } from '../config/cloudinary.js';
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
// Key by token when present, else fall through to the library's IP-safe
// keyGenerator (handles IPv6 correctly).
const tokenKeyGenerator = (req, res) =>
  req.params?.token || ipKeyGenerator(req, res);

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

// Allow-lists mirror the staff upload path (config/cloudinary.js). Excel is
// accepted globally at the filter layer for the IIL Protocol Sheet doc
// type; per-document-type restrictions live in config/documentTypes.js and
// are enforced at the UI via the per-doc `accept` attribute.
const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const ALLOWED_EXTS = new Set(['jpg', 'jpeg', 'png', 'pdf', 'doc', 'docx', 'xls', 'xlsx']);

const RAW_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const pickResourceType = (mimetype) => (RAW_MIMES.has(mimetype) ? 'raw' : 'auto');

const extractFormat = (originalname) =>
  (originalname.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();

// Raw uploads need the extension baked into the public_id; Cloudinary's own
// `allowed_formats` runs content-based format detection first and rejects
// anything it can't classify — xlsx/docx are ZIP-packaged and come back as
// "unknown", so we skip that validation and rely on the multer fileFilter
// (ALLOWED_MIMES + ALLOWED_EXTS) as the upstream whitelist.
const buildPublicId = (file) => {
  const base = `${Date.now()}-${sanitizePublicId(file.originalname)}`;
  if (pickResourceType(file.mimetype) === 'raw') {
    const ext = extractFormat(file.originalname);
    return ext ? `${base}.${ext}` : base;
  }
  return base;
};

// Custom storage that gets leadId from token validation
const createCustomerStorage = () => {
  return new CloudinaryStorage({
    cloudinary: cloudinary,
    params: async (req, file) => {
      // leadId is set by middleware after token validation
      const leadId = req.leadId || 'unknown';
      const documentType = req.params.documentType || 'general';

      return {
        folder: `isp_crm/documents/${leadId}/${documentType}`,
        resource_type: pickResourceType(file.mimetype),
        public_id: buildPublicId(file)
      };
    }
  });
};

const fileFilter = (req, file, cb) => {
  if (!ALLOWED_MIMES.has(file.mimetype)) {
    return cb(new Error('Only PDF, DOC, DOCX, XLS, XLSX, JPG, and PNG files are allowed'), false);
  }
  const ext = (file.originalname.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) {
    return cb(new Error('File extension does not match an allowed type.'), false);
  }
  cb(null, true);
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
