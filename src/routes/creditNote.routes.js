import express from 'express';
import { auth } from '../middleware/auth.js';
import {
  createCreditNote,
  getCreditNotesForInvoice,
  getAllCreditNotes,
  getCreditNoteById,
  adjustCreditNote,
  refundCreditNote,
  getCustomerCreditSummary
} from '../controllers/creditNote.controller.js';

const router = express.Router();

// All routes require authentication
router.use(auth);

// Get all credit notes with filters
router.get('/', getAllCreditNotes);

// Get credit note by ID
router.get('/:id', getCreditNoteById);

// Create credit note for an invoice
router.post('/invoice/:invoiceId', createCreditNote);

// Get all credit notes for an invoice
router.get('/invoice/:invoiceId', getCreditNotesForInvoice);

// Get customer credit summary
router.get('/customer/:leadId/summary', getCustomerCreditSummary);

// Mark credit note as adjusted
router.patch('/:id/adjust', adjustCreditNote);

// Mark credit note as refunded
router.patch('/:id/refund', refundCreditNote);

export default router;
