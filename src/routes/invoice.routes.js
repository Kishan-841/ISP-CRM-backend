import express from 'express';
import { auth, requireRole } from '../middleware/auth.js';
import {
  getAllInvoices,
  getInvoiceById,
  generateInvoice,
  generateOTCInvoice,
  updateInvoiceStatus,
  markInvoicePaid,
  bulkPayInvoices,
  getInvoiceableLeads,
  getLeadInvoices,
  getCustomersWithPendingInvoices,
  getCustomerInvoiceDetail,
  deleteInvoice,
  addPaymentToInvoice,
  recordAdvancePayment,
  getCustomerAdvanceBalance,
  settleAdvanceAgainstInvoice,
  getInvoicePayments,
  autoGenerateInvoices,
  checkPendingInvoices,
  updateCustomerDetails,
  migrateAdvancePaymentsFromCreditNotes,
  cleanupAllBillingData
} from '../controllers/invoice.controller.js';

const router = express.Router();

// All routes require authentication
router.use(auth);

// Get all invoices with filters
router.get('/', getAllInvoices);

// Get customers with pending invoices (grouped view)
router.get('/customers/pending', getCustomersWithPendingInvoices);

// Get leads eligible for invoicing
router.get('/leads/invoiceable', getInvoiceableLeads);

// Check which leads need invoices (preview)
router.get('/auto-generate/check', checkPendingInvoices);

// Auto-generate invoices for all leads that need them. Admin-gated because
// it runs a bulk job that mutates every active customer — pairs with the
// cron lock to prevent concurrent executions.
router.post('/auto-generate', requireRole('SUPER_ADMIN', 'ADMIN'), autoGenerateInvoices);

// Get invoices for a specific lead
router.get('/lead/:leadId', getLeadInvoices);

// Get customer detail with all invoices
router.get('/customer/:leadId', getCustomerInvoiceDetail);

// Update customer details (username, company name, mobile)
router.patch('/customer/:leadId/details', updateCustomerDetails);

// Get single invoice by ID
router.get('/:id', getInvoiceById);

// Get payment history for an invoice
router.get('/:id/payments', getInvoicePayments);

// Bulk pay multiple invoices
router.post('/bulk-pay', bulkPayInvoices);

// Generate invoice for a lead
router.post('/generate/:leadId', generateInvoice);

// Generate OTC (One Time Charge) invoice for a lead
router.post('/generate-otc/:leadId', generateOTCInvoice);

// Update invoice status
router.patch('/:id/status', updateInvoiceStatus);

// Mark invoice as paid with payment details (legacy - full payment)
router.post('/:id/pay', markInvoicePaid);

// Add a single payment to an invoice (supports partial payments)
router.post('/:id/payment', addPaymentToInvoice);

// Record advance payment (not tied to specific invoice)
router.post('/customer/:leadId/advance-payment', recordAdvancePayment);

// Get customer's advance balance
router.get('/customer/:leadId/advance-balance', getCustomerAdvanceBalance);

// Settle advance against invoice
router.post('/customer/:leadId/settle-advance', settleAdvanceAgainstInvoice);

// Migrate advance payments from credit notes (create missing ledger entries)
router.post('/migrate/credit-note-advances', migrateAdvancePaymentsFromCreditNotes);

// Cleanup all billing data for testing (SUPER_ADMIN only)
router.delete('/cleanup/all-billing-data', requireRole('SUPER_ADMIN'), cleanupAllBillingData);

// Delete invoice
router.delete('/:id', deleteInvoice);

export default router;
