import prisma from '../config/db.js';
import { createRefundLedgerEntry } from '../services/ledger.service.js';
import { generateCreditNoteNumber } from '../services/documentNumber.service.js';
import { emitSidebarRefreshByRole } from '../sockets/index.js';
import { asyncHandler, parsePagination, buildSearchFilter } from '../utils/controllerHelper.js';
import { isAdminOrTestUser, hasAnyRole } from '../utils/roleHelper.js';

const canAccessFinancials = (user) => {
  return isAdminOrTestUser(user) || hasAnyRole(user, ['ACCOUNTS_TEAM', 'OPS_TEAM']);
};

/**
 * Calculate invoice amounts following strict accounting rules
 * netPayableAmount = grandTotal - totalCreditAmount
 * remainingAmount = netPayableAmount - totalPaidAmount
 */
const calculateInvoiceAmounts = (invoice) => {
  const grandTotal = invoice.grandTotal;
  const totalCreditAmount = invoice.totalCreditAmount || 0;
  const totalPaidAmount = invoice.totalPaidAmount || 0;

  const netPayableAmount = grandTotal - totalCreditAmount;
  const remainingAmount = netPayableAmount - totalPaidAmount;

  return {
    grandTotal,
    totalCreditAmount,
    totalPaidAmount,
    netPayableAmount,
    remainingAmount
  };
};

/**
 * Determine invoice status based on accounting rules
 */
const determineInvoiceStatus = (invoice) => {
  const { netPayableAmount, remainingAmount, totalPaidAmount } = calculateInvoiceAmounts(invoice);

  // CANCELLED: netPayableAmount = 0 (full credit note issued)
  if (netPayableAmount <= 0) {
    return 'CANCELLED';
  }

  // PAID: remainingAmount = 0
  if (remainingAmount <= 1) { // 1 rupee tolerance
    return 'PAID';
  }

  // PARTIALLY_PAID: remainingAmount > 0 AND totalPaidAmount > 0
  if (remainingAmount > 0 && totalPaidAmount > 0) {
    return 'PARTIALLY_PAID';
  }

  // OVERDUE: dueDate passed AND remainingAmount > 0
  const now = new Date();
  if (invoice.dueDate < now && remainingAmount > 0) {
    return 'OVERDUE';
  }

  // GENERATED: default state
  return 'GENERATED';
};

/**
 * Create a Credit Note for an invoice
 *
 * ACCOUNTING RULES:
 * - Credit Note must reference exactly one invoice
 * - Credit amount cannot exceed grandTotal - existing credit notes
 * - Credit Note must have proper GST breakdown
 * - Credit Note does NOT affect payments, only reduces legal demand
 *
 * SPECIAL HANDLING FOR PAID INVOICES:
 * - If invoice is already PAID (totalPaidAmount >= grandTotal), the credit note
 *   amount is automatically added to customer's advance payment balance
 * - This advance payment can be settled against future invoices
 * - The advance payment receipt number links back to the credit note for audit trail
 */
export const createCreditNote = asyncHandler(async function createCreditNote(req, res) {
  if (!canAccessFinancials(req.user)) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const { invoiceId } = req.params;
  const userId = req.user.id;
  const {
    baseAmount,
    reason,
    remarks
  } = req.body;

  // Validate required fields
  if (!baseAmount || baseAmount <= 0) {
    return res.status(400).json({ message: 'Base amount is required and must be greater than 0.' });
  }

  if (!reason) {
    return res.status(400).json({ message: 'Reason is required.' });
  }

  // Validate reason
  const validReasons = ['SERVICE_DOWNTIME', 'OVERPAYMENT', 'PRICE_ADJUSTMENT', 'CANCELLATION', 'ERROR_CORRECTION', 'PLAN_DOWNGRADE'];
  if (!validReasons.includes(reason)) {
    return res.status(400).json({ message: `Invalid reason. Must be one of: ${validReasons.join(', ')}` });
  }

  // Get the invoice
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      creditNotes: true,
      lead: {
        include: {
          campaignData: { select: { company: true } }
        }
      }
    }
  });

  if (!invoice) {
    return res.status(404).json({ message: 'Invoice not found.' });
  }

  // Cannot issue credit note for CANCELLED invoice
  if (invoice.status === 'CANCELLED') {
    return res.status(400).json({ message: 'Cannot issue credit note for a cancelled invoice.' });
  }

  // Calculate max allowable credit
  const existingCreditTotal = invoice.totalCreditAmount || 0;
  const maxAllowableCredit = invoice.grandTotal - existingCreditTotal;

  // Check if this is a PAID invoice
  const isPaidInvoice = invoice.status === 'PAID' && invoice.totalPaidAmount >= invoice.grandTotal;

  // Calculate GST amounts (mirror invoice tax structure)
  const sgstRate = invoice.sgstRate || 9;
  const cgstRate = invoice.cgstRate || 9;
  const sgstAmount = (baseAmount * sgstRate) / 100;
  const cgstAmount = (baseAmount * cgstRate) / 100;
  const totalGstAmount = sgstAmount + cgstAmount;
  const totalAmount = baseAmount + totalGstAmount;

  // Validate credit amount doesn't exceed allowable
  if (totalAmount > maxAllowableCredit + 1) { // 1 rupee tolerance
    return res.status(400).json({
      message: `Credit amount (₹${totalAmount.toFixed(2)}) exceeds maximum allowable (₹${maxAllowableCredit.toFixed(2)}).`,
      maxAllowableCredit
    });
  }

  // Generate credit note number
  const creditNoteNumber = await generateCreditNoteNumber();

  // Create credit note as PENDING_APPROVAL - no invoice/ledger changes until admin approves
  const creditNote = await prisma.creditNote.create({
    data: {
      creditNoteNumber,
      invoiceId,
      baseAmount,
      sgstRate,
      cgstRate,
      sgstAmount,
      cgstAmount,
      totalGstAmount,
      totalAmount,
      reason,
      status: 'PENDING_APPROVAL',
      remarks,
      createdById: userId
    },
    include: {
      createdBy: { select: { id: true, name: true } },
      invoice: { select: { invoiceNumber: true } }
    }
  });

  // Notify admin for approval
  emitSidebarRefreshByRole('SUPER_ADMIN');
  emitSidebarRefreshByRole('ADMIN');

  res.status(201).json({
    message: 'Credit note created and sent for admin approval.',
    creditNote
  });
});

/**
 * Get all credit notes for an invoice
 */
export const getCreditNotesForInvoice = asyncHandler(async function getCreditNotesForInvoice(req, res) {
  const { invoiceId } = req.params;

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true,
      invoiceNumber: true,
      grandTotal: true,
      totalCreditAmount: true,
      totalPaidAmount: true,
      remainingAmount: true,
      status: true
    }
  });

  if (!invoice) {
    return res.status(404).json({ message: 'Invoice not found.' });
  }

  const creditNotes = await prisma.creditNote.findMany({
    where: { invoiceId },
    include: {
      createdBy: { select: { id: true, name: true } }
    },
    orderBy: { createdAt: 'desc' }
  });

  res.json({
    invoice: {
      ...invoice,
      netPayableAmount: invoice.grandTotal - (invoice.totalCreditAmount || 0)
    },
    creditNotes,
    summary: {
      totalCreditNotes: creditNotes.length,
      totalCreditAmount: invoice.totalCreditAmount || 0,
      maxAdditionalCredit: invoice.grandTotal - (invoice.totalCreditAmount || 0)
    }
  });
});

/**
 * Get all credit notes with filters
 */
export const getAllCreditNotes = asyncHandler(async function getAllCreditNotes(req, res) {
  const { status, reason, search } = req.query;
  const { page, limit, skip } = parsePagination(req.query, 20);

  const where = {};

  if (status) {
    where.status = status;
  }

  if (reason) {
    where.reason = reason;
  }

  if (search) {
    where.OR = buildSearchFilter(search, [
      'creditNoteNumber',
      'invoice.invoiceNumber',
      'invoice.companyName'
    ]);
  }

  const [creditNotes, total] = await Promise.all([
    prisma.creditNote.findMany({
      where,
      include: {
        invoice: {
          select: {
            id: true,
            invoiceNumber: true,
            companyName: true,
            grandTotal: true
          }
        },
        createdBy: { select: { id: true, name: true } }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit
    }),
    prisma.creditNote.count({ where })
  ]);

  // Get summary stats
  const stats = await prisma.creditNote.groupBy({
    by: ['status'],
    _count: { id: true },
    _sum: { totalAmount: true }
  });

  const statsObj = {
    total: 0,
    issued: 0,
    adjusted: 0,
    refunded: 0,
    totalAmount: 0
  };

  stats.forEach(s => {
    statsObj.total += s._count.id;
    statsObj[s.status.toLowerCase()] = s._count.id;
    statsObj.totalAmount += s._sum.totalAmount || 0;
  });

  res.json({
    creditNotes,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    },
    stats: statsObj
  });
});

/**
 * Get credit note by ID
 */
export const getCreditNoteById = asyncHandler(async function getCreditNoteById(req, res) {
  const { id } = req.params;

  const creditNote = await prisma.creditNote.findUnique({
    where: { id },
    include: {
      invoice: {
        select: {
          id: true,
          invoiceNumber: true,
          companyName: true,
          customerUsername: true,
          billingAddress: true,
          contactPhone: true,
          contactEmail: true,
          buyerGstNo: true,
          grandTotal: true,
          totalCreditAmount: true,
          totalPaidAmount: true,
          remainingAmount: true,
          status: true,
          invoiceDate: true
        }
      },
      createdBy: { select: { id: true, name: true } },
      adjustedAgainstInvoice: {
        select: { id: true, invoiceNumber: true, companyName: true }
      }
    }
  });

  if (!creditNote) {
    return res.status(404).json({ message: 'Credit note not found.' });
  }

  res.json(creditNote);
});

/**
 * Mark credit note as adjusted (used against another invoice)
 */
export const adjustCreditNote = asyncHandler(async function adjustCreditNote(req, res) {
  if (!canAccessFinancials(req.user)) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const { id } = req.params;
  const { adjustAgainstInvoiceId } = req.body;

  if (!adjustAgainstInvoiceId) {
    return res.status(400).json({ message: 'Invoice ID to adjust against is required.' });
  }

  const creditNote = await prisma.creditNote.findUnique({
    where: { id }
  });

  if (!creditNote) {
    return res.status(404).json({ message: 'Credit note not found.' });
  }

  if (creditNote.status !== 'ISSUED') {
    return res.status(400).json({ message: `Cannot adjust credit note with status: ${creditNote.status}` });
  }

  // Get the original invoice for recalculation and customer verification
  const originalInvoice = await prisma.invoice.findUnique({
    where: { id: creditNote.invoiceId }
  });

  if (!originalInvoice) {
    return res.status(404).json({ message: 'Original invoice not found.' });
  }

  // Verify the target invoice exists and belongs to the same customer
  const targetInvoice = await prisma.invoice.findUnique({
    where: { id: adjustAgainstInvoiceId }
  });

  if (!targetInvoice) {
    return res.status(404).json({ message: 'Target invoice not found.' });
  }

  if (targetInvoice.leadId !== originalInvoice.leadId) {
    return res.status(400).json({ message: 'Target invoice must belong to the same customer.' });
  }

  const updatedCreditNote = await prisma.$transaction(async (tx) => {
    const updated = await tx.creditNote.update({
      where: { id },
      data: {
        status: 'ADJUSTED',
        adjustedAgainstInvoiceId,
        adjustedAt: new Date()
      },
      include: {
        adjustedAgainstInvoice: {
          select: { id: true, invoiceNumber: true }
        }
      }
    });

    // Recalculate original invoice amounts from actual credit notes
    if (originalInvoice) {
      const totalCredits = await tx.creditNote.aggregate({
        where: { invoiceId: originalInvoice.id, status: { in: ['ISSUED', 'ADJUSTED', 'REFUNDED'] } },
        _sum: { totalAmount: true },
      });
      const totalCreditAmount = totalCredits._sum.totalAmount || 0;

      await tx.invoice.update({
        where: { id: originalInvoice.id },
        data: {
          totalCreditAmount,
          remainingAmount: originalInvoice.grandTotal - originalInvoice.totalPaidAmount - totalCreditAmount,
        },
      });
    }

    return updated;
  });

  // Notify accounts team of credit note adjustment
  emitSidebarRefreshByRole('ACCOUNTS_TEAM');
  emitSidebarRefreshByRole('SUPER_ADMIN');

  res.json({
    message: 'Credit note marked as adjusted.',
    creditNote: updatedCreditNote
  });
});

/**
 * Mark credit note as refunded
 */
export const refundCreditNote = asyncHandler(async function refundCreditNote(req, res) {
  if (!canAccessFinancials(req.user)) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const { id } = req.params;
  const { refundReference, refundMode } = req.body;

  const creditNote = await prisma.creditNote.findUnique({
    where: { id }
  });

  if (!creditNote) {
    return res.status(404).json({ message: 'Credit note not found.' });
  }

  if (creditNote.status !== 'ISSUED') {
    return res.status(400).json({ message: `Cannot refund credit note with status: ${creditNote.status}` });
  }

  // Get the invoice to find the customer and for recalculation
  const invoice = await prisma.invoice.findUnique({
    where: { id: creditNote.invoiceId }
  });

  const updatedCreditNote = await prisma.$transaction(async (tx) => {
    const updated = await tx.creditNote.update({
      where: { id },
      data: {
        status: 'REFUNDED',
        refundedAt: new Date(),
        refundReference,
        refundMode
      }
    });

    // Recalculate invoice amounts from actual credit notes
    if (invoice) {
      const totalCredits = await tx.creditNote.aggregate({
        where: { invoiceId: invoice.id, status: { in: ['ISSUED', 'ADJUSTED', 'REFUNDED'] } },
        _sum: { totalAmount: true },
      });
      const totalCreditAmount = totalCredits._sum.totalAmount || 0;

      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          totalCreditAmount,
          remainingAmount: invoice.grandTotal - invoice.totalPaidAmount - totalCreditAmount,
        },
      });

      // Create refund ledger entry INSIDE transaction
      const lastEntry = await tx.ledgerEntry.findFirst({
        where: { customerId: invoice.leadId },
        orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
        select: { runningBalance: true }
      });
      const prevBalance = Number(lastEntry?.runningBalance) || 0;
      const debitAmount = Number(creditNote.totalAmount);

      await tx.ledgerEntry.create({
        data: {
          customerId: invoice.leadId,
          entryDate: new Date(),
          entryType: 'REFUND',
          referenceType: 'CREDIT_NOTE',
          referenceId: creditNote.id,
          referenceNumber: refundReference || `REF-${Date.now()}`,
          debitAmount,
          creditAmount: 0,
          runningBalance: prevBalance + debitAmount,
          description: `Refund processed via ${refundMode || 'Bank Transfer'} for Credit Note ${creditNote.creditNoteNumber}`,
          createdById: req.user?.id
        }
      });
    }

    return updated;
  });

  // Notify accounts team of credit note refund
  emitSidebarRefreshByRole('ACCOUNTS_TEAM');
  emitSidebarRefreshByRole('SUPER_ADMIN');

  res.json({
    message: 'Credit note marked as refunded.',
    creditNote: updatedCreditNote
  });
});

/**
 * Get credit notes summary for a customer (lead)
 */
export const getCustomerCreditSummary = asyncHandler(async function getCustomerCreditSummary(req, res) {
  const { leadId } = req.params;

  // Get all invoices for the lead
  const invoices = await prisma.invoice.findMany({
    where: { leadId },
    include: {
      creditNotes: {
        orderBy: { createdAt: 'desc' }
      }
    }
  });

  // Calculate totals
  let totalInvoiced = 0;
  let totalCredited = 0;
  let totalPaid = 0;
  const allCreditNotes = [];

  invoices.forEach(inv => {
    totalInvoiced += inv.grandTotal;
    totalCredited += inv.totalCreditAmount || 0;
    totalPaid += inv.totalPaidAmount || 0;
    allCreditNotes.push(...inv.creditNotes);
  });

  // Credit notes by status
  const issuedCredits = allCreditNotes.filter(cn => cn.status === 'ISSUED');
  const adjustedCredits = allCreditNotes.filter(cn => cn.status === 'ADJUSTED');
  const refundedCredits = allCreditNotes.filter(cn => cn.status === 'REFUNDED');

  res.json({
    summary: {
      totalInvoiced,
      totalCredited,
      totalPaid,
      netReceivable: totalInvoiced - totalCredited - totalPaid,
      availableCredit: issuedCredits.reduce((sum, cn) => sum + cn.totalAmount, 0)
    },
    creditNotes: {
      total: allCreditNotes.length,
      issued: issuedCredits.length,
      adjusted: adjustedCredits.length,
      refunded: refundedCredits.length
    },
    recentCreditNotes: allCreditNotes.slice(0, 5)
  });
});

/**
 * Get pending credit notes for admin approval
 * GET /credit-notes/pending-approval
 */
export const getPendingCreditNotes = asyncHandler(async function getPendingCreditNotes(req, res) {
  if (!isAdminOrTestUser(req.user)) {
    return res.status(403).json({ message: 'Only admins can view pending credit notes.' });
  }

  const creditNotes = await prisma.creditNote.findMany({
    where: { status: 'PENDING_APPROVAL' },
    include: {
      invoice: {
        select: {
          id: true, invoiceNumber: true, grandTotal: true, totalCreditAmount: true,
          totalPaidAmount: true, remainingAmount: true, status: true,
          lead: { select: { id: true, campaignData: { select: { company: true, name: true } } } }
        }
      },
      createdBy: { select: { id: true, name: true, role: true } }
    },
    orderBy: { createdAt: 'desc' }
  });

  res.json({ creditNotes, total: creditNotes.length });
});

/**
 * Approve a credit note - applies invoice/ledger changes
 * POST /credit-notes/:id/approve
 */
export const approveCreditNote = asyncHandler(async function approveCreditNote(req, res) {
  if (!isAdminOrTestUser(req.user)) {
    return res.status(403).json({ message: 'Only admins can approve credit notes.' });
  }

  const { id } = req.params;
  const userId = req.user.id;

  const creditNote = await prisma.creditNote.findUnique({
    where: { id },
    include: {
      invoice: {
        include: {
          lead: { include: { campaignData: { select: { company: true } } } }
        }
      }
    }
  });

  if (!creditNote) {
    return res.status(404).json({ message: 'Credit note not found.' });
  }

  if (creditNote.status !== 'PENDING_APPROVAL') {
    return res.status(400).json({ message: 'Only pending credit notes can be approved.' });
  }

  const invoice = creditNote.invoice;
  const isPaidInvoice = invoice.status === 'PAID' && invoice.totalPaidAmount >= invoice.grandTotal;

  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      // Update credit note status to ISSUED
      const updatedCreditNote = await tx.creditNote.update({
        where: { id },
        data: { status: 'ISSUED' },
        include: { createdBy: { select: { id: true, name: true } } }
      });

      // Recalculate invoice amounts from ISSUED credit notes
      const totalCredits = await tx.creditNote.aggregate({
        where: { invoiceId: invoice.id, status: { in: ['ISSUED', 'ADJUSTED'] } },
        _sum: { totalAmount: true }
      });
      const totalCreditAmount = totalCredits._sum.totalAmount || 0;

      if (totalCreditAmount > invoice.grandTotal + 1) {
        throw new Error('CREDIT_CAP_EXCEEDED');
      }

      const netPayableAmount = invoice.grandTotal - totalCreditAmount;
      const newRemainingAmount = netPayableAmount - (invoice.totalPaidAmount || 0);

      let newStatus = invoice.status;
      if (netPayableAmount <= 0) newStatus = 'CANCELLED';
      else if (newRemainingAmount <= 1) newStatus = 'PAID';
      else if (newRemainingAmount > 0 && (invoice.totalPaidAmount || 0) > 0) newStatus = 'PARTIALLY_PAID';
      else if (invoice.dueDate < new Date() && newRemainingAmount > 0) newStatus = 'OVERDUE';
      else newStatus = 'GENERATED';

      const updatedInvoice = await tx.invoice.update({
        where: { id: invoice.id },
        data: { totalCreditAmount, remainingAmount: Math.max(0, newRemainingAmount), status: newStatus }
      });

      // Create ledger entry
      const reasonMap = {
        'SERVICE_DOWNTIME': 'Service Downtime', 'OVERPAYMENT': 'Overpayment',
        'PRICE_ADJUSTMENT': 'Price Adjustment', 'CANCELLATION': 'Cancellation',
        'ERROR_CORRECTION': 'Error Correction', 'PLAN_DOWNGRADE': 'Plan Downgrade'
      };
      const reasonLabel = reasonMap[creditNote.reason] || creditNote.reason;

      const lastEntry = await tx.ledgerEntry.findFirst({
        where: { customerId: invoice.leadId },
        orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
        select: { runningBalance: true }
      });
      const previousBalance = lastEntry?.runningBalance || 0;
      const runningBalance = previousBalance - creditNote.totalAmount;

      await tx.ledgerEntry.create({
        data: {
          customerId: invoice.leadId,
          entryDate: new Date(),
          entryType: 'CREDIT_NOTE',
          referenceType: 'CREDIT_NOTE',
          referenceId: creditNote.id,
          referenceNumber: creditNote.creditNoteNumber,
          debitAmount: 0,
          creditAmount: creditNote.totalAmount,
          runningBalance,
          description: `Credit Note ${creditNote.creditNoteNumber} approved - ${reasonLabel} against ${invoice.invoiceNumber}`,
          createdById: userId
        }
      });

      // If invoice was PAID, create advance payment
      let advancePayment = null;
      if (isPaidInvoice) {
        const timestamp = Date.now();
        const random = Math.floor(Math.random() * 1000);
        advancePayment = await tx.advancePayment.create({
          data: {
            receiptNumber: `ADV-CN-${timestamp}-${random}`,
            leadId: invoice.leadId,
            amount: creditNote.totalAmount,
            paymentMode: 'CREDIT_NOTE',
            remark: `Advance from Credit Note ${creditNote.creditNoteNumber} for Invoice ${invoice.invoiceNumber}`,
            provisionalReceiptNo: creditNote.creditNoteNumber,
            transactionDate: new Date(),
            createdById: userId
          }
        });
      }

      return { creditNote: updatedCreditNote, invoice: updatedInvoice, advancePayment };
    });
  } catch (error) {
    if (error.message === 'CREDIT_CAP_EXCEEDED') {
      return res.status(400).json({ message: 'Total credit notes exceed invoice amount.' });
    }
    throw error;
  }

  emitSidebarRefreshByRole('ACCOUNTS_TEAM');
  emitSidebarRefreshByRole('SUPER_ADMIN');

  res.json({
    message: 'Credit note approved and applied successfully.',
    creditNote: result.creditNote,
    invoice: result.invoice
  });
});

/**
 * Reject a credit note
 * POST /credit-notes/:id/reject
 */
export const rejectCreditNote = asyncHandler(async function rejectCreditNote(req, res) {
  if (!isAdminOrTestUser(req.user)) {
    return res.status(403).json({ message: 'Only admins can reject credit notes.' });
  }

  const { id } = req.params;
  const { rejectionReason } = req.body;

  const creditNote = await prisma.creditNote.findUnique({ where: { id } });

  if (!creditNote) {
    return res.status(404).json({ message: 'Credit note not found.' });
  }

  if (creditNote.status !== 'PENDING_APPROVAL') {
    return res.status(400).json({ message: 'Only pending credit notes can be rejected.' });
  }

  const updated = await prisma.creditNote.update({
    where: { id },
    data: {
      status: 'REJECTED',
      remarks: creditNote.remarks
        ? `${creditNote.remarks}\n[REJECTED: ${rejectionReason || 'No reason provided'}]`
        : `[REJECTED: ${rejectionReason || 'No reason provided'}]`
    },
    include: { createdBy: { select: { id: true, name: true } } }
  });

  emitSidebarRefreshByRole('ACCOUNTS_TEAM');

  res.json({ message: 'Credit note rejected.', creditNote: updated });
});
