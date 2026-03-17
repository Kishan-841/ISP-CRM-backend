import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import multer from 'multer';

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Generic storage for backward compatibility (generic document uploads)
const genericStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    // Determine resource type based on file mimetype
    let resourceType = 'auto';

    // For PDFs and documents, use 'raw' resource type
    if (file.mimetype === 'application/pdf' ||
        file.mimetype === 'application/msword' ||
        file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      resourceType = 'raw';
    }

    return {
      folder: 'isp_crm/documents',
      resource_type: resourceType,
      allowed_formats: ['jpg', 'jpeg', 'png', 'pdf', 'doc', 'docx'],
      // Use original filename with timestamp for uniqueness
      public_id: `${Date.now()}-${file.originalname.replace(/\.[^/.]+$/, '')}`
    };
  }
});

// Typed storage for organized document uploads (by leadId and documentType)
const typedStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    // Get leadId from route params and documentType from route params or body
    const leadId = req.params.id || req.body.leadId || 'unknown';
    const documentType = req.params.documentType || req.body.documentType || 'general';

    // Determine resource type based on file mimetype
    let resourceType = 'auto';

    // For PDFs and documents, use 'raw' resource type
    if (file.mimetype === 'application/pdf' ||
        file.mimetype === 'application/msword' ||
        file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      resourceType = 'raw';
    }

    return {
      folder: `isp_crm/documents/${leadId}/${documentType}`,
      resource_type: resourceType,
      allowed_formats: ['jpg', 'jpeg', 'png', 'pdf', 'doc', 'docx'],
      // Use original filename with timestamp for uniqueness
      public_id: `${Date.now()}-${file.originalname.replace(/\.[^/.]+$/, '')}`
    };
  }
});

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

// Create multer upload instances
const uploadToCloudinary = multer({
  storage: genericStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: fileFilter
});

// Typed document upload (for single document type uploads)
const uploadTypedDocument = multer({
  storage: typedStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: fileFilter
});

// Complaint attachment storage (organized by complaintId)
const complaintStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    const complaintId = req.params.id || 'unknown';

    let resourceType = 'auto';
    if (file.mimetype === 'application/pdf' ||
        file.mimetype === 'application/msword' ||
        file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      resourceType = 'raw';
    }

    return {
      folder: `isp_crm/complaints/${complaintId}`,
      resource_type: resourceType,
      allowed_formats: ['jpg', 'jpeg', 'png', 'pdf', 'doc', 'docx'],
      public_id: `${Date.now()}-${file.originalname.replace(/\.[^/.]+$/, '')}`
    };
  }
});

const uploadComplaintAttachments = multer({
  storage: complaintStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
  fileFilter: fileFilter
});

// Service order attachment storage (organized by orderId)
const orderStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    const orderId = req.params.id || 'unknown';

    let resourceType = 'auto';
    if (file.mimetype === 'application/pdf' ||
        file.mimetype === 'application/msword' ||
        file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      resourceType = 'raw';
    }

    return {
      folder: `isp_crm/orders/${orderId}`,
      resource_type: resourceType,
      allowed_formats: ['jpg', 'jpeg', 'png', 'pdf', 'doc', 'docx'],
      public_id: `${Date.now()}-${file.originalname.replace(/\.[^/.]+$/, '')}`
    };
  }
});

const uploadOrderAttachments = multer({
  storage: orderStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
  fileFilter: fileFilter
});

// Helper to delete file from Cloudinary
const deleteFromCloudinary = async (publicId, resourceType = 'image') => {
  try {
    const result = await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    return result;
  } catch (error) {
    console.error('Error deleting from Cloudinary:', error);
    throw error;
  }
};

// Helper to get resource type from mimetype
const getResourceType = (mimetype) => {
  if (mimetype?.startsWith('image/')) return 'image';
  return 'raw';
};

// Helper to delete multiple files from Cloudinary
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
  getResourceType
};
