import express from 'express';
import { auth } from '../middleware/auth.js';
import { uploadToCloudinary } from '../config/cloudinary.js';
import {
  sendQuotationEmail,
  getEmailHistory,
  getMyEmails
} from '../controllers/email.controller.js';

const router = express.Router();

// All routes require authentication
router.use(auth);

// Upload attachment for email
// POST /api/emails/upload-attachment
router.post('/upload-attachment', uploadToCloudinary.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    res.json({
      success: true,
      url: req.file.path,
      filename: req.file.originalname,
      size: req.file.size,
      publicId: req.file.filename
    });
  } catch (error) {
    console.error('Attachment upload error:', error);
    res.status(500).json({ message: 'Failed to upload attachment' });
  }
});

// Send quotation email
// POST /api/emails/send
router.post('/send', sendQuotationEmail);

// Get email history for a specific reference (lead/campaignData)
// GET /api/emails/history/:referenceId
router.get('/history/:referenceId', getEmailHistory);

// Get user's own email history
// GET /api/emails/my
router.get('/my', getMyEmails);

export default router;
