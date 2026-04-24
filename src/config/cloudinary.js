import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import multer from 'multer';

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Cloudinary public_ids only allow letters, numbers, underscores, hyphens,
// and forward slashes. Spaces, `&`, `(`, `)`, etc. trigger a 400 and — via
// the multer-storage-cloudinary@4 / multer@2 mismatch — an unhandled
// rejection that crashes the server.
const sanitizePublicId = (originalName) =>
  originalName
    .replace(/\.[^/.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 100) || 'file';

// ─── Allow-lists ────────────────────────────────────────────────────────────
// Three-layer defense on file uploads:
//   1. fileFilter checks the client-sent Content-Type against ALLOWED_MIMES.
//   2. fileFilter also checks the file extension against ALLOWED_EXTS —
//      needed because Content-Type is trivially spoofable (an SVG renamed to
//      `doc.pdf` with a spoofed `image/png` mimetype passes the mimetype
//      check alone).
//   3. Cloudinary's `allowed_formats` inspects the actual uploaded content
//      and rejects anything outside the whitelist.
// Full magic-byte validation would require switching from CloudinaryStorage
// to memoryStorage + manual upload — out of scope.

const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // Excel — enabled globally for the IIL Protocol Sheet. Per-document-type
  // acceptance lives in config/documentTypes.js and the upload UI's
  // per-doc `accept` attribute.
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const ALLOWED_EXTS = new Set(['jpg', 'jpeg', 'png', 'pdf', 'doc', 'docx', 'xls', 'xlsx']);

// Cloudinary stores images under resource_type: 'image' (with its own
// transformation pipeline) and everything else under 'raw'. Non-image
// content forced into the image bucket fails to decode — so every non-image
// MIME here MUST map to 'raw' at storage time.
const RAW_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const pickResourceType = (mimetype) => (RAW_MIMES.has(mimetype) ? 'raw' : 'auto');

const CLOUDINARY_ALLOWED_FORMATS = ['jpg', 'jpeg', 'png', 'pdf', 'doc', 'docx', 'xls', 'xlsx'];

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

// ─── Storage configs ────────────────────────────────────────────────────────

// Generic storage for backward compatibility (generic document uploads)
const genericStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => ({
    folder: 'isp_crm/documents',
    resource_type: pickResourceType(file.mimetype),
    allowed_formats: CLOUDINARY_ALLOWED_FORMATS,
    public_id: `${Date.now()}-${sanitizePublicId(file.originalname)}`
  })
});

// Typed storage for organized document uploads (by leadId and documentType)
const typedStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    const leadId = req.params.id || req.body.leadId || 'unknown';
    const documentType = req.params.documentType || req.body.documentType || 'general';

    return {
      folder: `isp_crm/documents/${leadId}/${documentType}`,
      resource_type: pickResourceType(file.mimetype),
      allowed_formats: CLOUDINARY_ALLOWED_FORMATS,
      public_id: `${Date.now()}-${sanitizePublicId(file.originalname)}`
    };
  }
});

// Complaint attachment storage (organized by complaintId)
const complaintStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    const complaintId = req.params.id || 'unknown';

    return {
      folder: `isp_crm/complaints/${complaintId}`,
      resource_type: pickResourceType(file.mimetype),
      allowed_formats: CLOUDINARY_ALLOWED_FORMATS,
      public_id: `${Date.now()}-${sanitizePublicId(file.originalname)}`
    };
  }
});

// Service order attachment storage (organized by orderId)
const orderStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    const orderId = req.params.id || 'unknown';

    return {
      folder: `isp_crm/orders/${orderId}`,
      resource_type: pickResourceType(file.mimetype),
      allowed_formats: CLOUDINARY_ALLOWED_FORMATS,
      public_id: `${Date.now()}-${sanitizePublicId(file.originalname)}`
    };
  }
});

// ─── Multer instances ───────────────────────────────────────────────────────

const uploadToCloudinary = multer({
  storage: genericStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: fileFilter
});

const uploadTypedDocument = multer({
  storage: typedStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: fileFilter
});

const uploadComplaintAttachments = multer({
  storage: complaintStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: fileFilter
});

const uploadOrderAttachments = multer({
  storage: orderStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: fileFilter
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const deleteFromCloudinary = async (publicId, resourceType = 'image') => {
  try {
    const result = await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    return result;
  } catch (error) {
    console.error('Error deleting from Cloudinary:', error);
    throw error;
  }
};

// Resolve resource_type from a stored file's mimetype. Used for deletion
// (matches where we originally put the file).
const getResourceType = (mimetype) => {
  if (mimetype?.startsWith('image/')) return 'image';
  return 'raw';
};

const deleteMultipleFromCloudinary = async (files) => {
  const results = [];
  for (const file of files) {
    try {
      const resourceType = getResourceType(file.mimetype);
      const result = await deleteFromCloudinary(file.publicId || file.filename, resourceType);
      results.push({ publicId: file.publicId || file.filename, success: true, result });
    } catch (error) {
      results.push({ publicId: file.publicId || file.filename, success: false, error: error.message });
    }
  }
  return results;
};

export {
  cloudinary,
  uploadToCloudinary,
  uploadTypedDocument,
  uploadComplaintAttachments,
  uploadOrderAttachments,
  deleteFromCloudinary,
  deleteMultipleFromCloudinary,
  getResourceType,
  sanitizePublicId
};
