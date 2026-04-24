import prisma from '../config/db.js';
import { isAdminOrTestUser, canHardDelete, hasRole, hasAnyRole } from '../utils/roleHelper.js';
import { emitSidebarRefresh, emitSidebarRefreshByRole } from '../sockets/index.js';
import {
  generateInvoiceNumber,
  generateOTCInvoiceNumber,
  generateReceiptNumber,
  generateAdvancePaymentNumber
} from '../services/documentNumber.service.js';
import {
  createInvoiceLedgerEntry,
  createPaymentLedgerEntry,
  deleteLedgerEntriesForInvoice,
  getCustomerBalance
} from '../services/ledger.service.js';
import { generateInvoiceForLead, withInvoiceJobLock } from '../jobs/invoiceGeneration.js';
import { asyncHandler, parsePagination, buildDateFilter, buildSearchFilter, paginatedResponse } from '../utils/controllerHelper.js';

// ---------------------------------------------------------------------------
// Permission helper: returns true if user can access financial operations
// ---------------------------------------------------------------------------
const canAccessFinancials = (user) => {
  return isAdminOrTestUser(user) || hasAnyRole(user, ['ACCOUNTS_TEAM', 'OPS_TEAM']);
};

// ---------------------------------------------------------------------------
// 1. GET /  -  getAllInvoices
// ---------------------------------------------------------------------------
export const getAllInvoices = asyncHandler(async function getAllInvoices(req, res) {
    const { page, limit, skip } = parsePagination(req.query, 25);
    const { search, status, leadId, fromDate, toDate } = req.query;

    const where = {};

    if (status) {
      where.status = status;
    }

    if (leadId) {
      where.leadId = leadId;
    }

    const dateFilter = buildDateFilter(fromDate, toDate);
    if (dateFilter) {
      where.invoiceDate = dateFilter;
    }

    const searchOR = buildSearchFilter(search, [
      'invoiceNumber',
      'companyName',
      'customerUsername'
    ]);
    if (searchOR) {
      where.OR = searchOR;
    }

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        select: {
          id: true,
          invoiceNumber: true,
          leadId: true,
          invoiceDate: true,
          dueDate: true,
          billingPeriodStart: true,
          billingPeriodEnd: true,
          companyName: true,
          customerUsername: true,
          planName: true,
          baseAmount: true,
          taxableAmount: true,
          sgstAmount: true,
          cgstAmount: true,
          totalGstAmount: true,
          grandTotal: true,
          status: true,
          totalPaidAmount: true,
          totalCreditAmount: true,
          remainingAmount: true,
          createdAt: true,
          createdBy: { select: { id: true, name: true } }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.invoice.count({ where })
    ]);

    // Summary stats
    const stats = await prisma.invoice.groupBy({
      by: ['status'],
      _count: { id: true },
      _sum: { grandTotal: true, totalPaidAmount: true }
    });

    const statsObj = {
      total: 0,
      generated: 0,
      partiallyPaid: 0,
      paid: 0,
      overdue: 0,
      cancelled: 0,
      totalAmount: 0,
      totalPaid: 0
    };

    stats.forEach((s) => {
      statsObj.total += s._count.id;
      statsObj.totalAmount += s._sum.grandTotal || 0;
      statsObj.totalPaid += s._sum.totalPaidAmount || 0;
      switch (s.status) {
        case 'GENERATED': statsObj.generated = s._count.id; break;
        case 'PARTIALLY_PAID': statsObj.partiallyPaid = s._count.id; break;
        case 'PAID': statsObj.paid = s._count.id; break;
        case 'OVERDUE': statsObj.overdue = s._count.id; break;
        case 'CANCELLED': statsObj.cancelled = s._count.id; break;
      }
    });

    res.json(paginatedResponse({
      data: invoices,
      total,
      page,
      limit,
      extra: { stats: statsObj }
    }));
});

// ---------------------------------------------------------------------------
// 2. GET /:id  -  getInvoiceById
// ---------------------------------------------------------------------------
export const getInvoiceById = asyncHandler(async function getInvoiceById(req, res) {
    const { id } = req.params;

    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: {
        lead: {
          select: {
            id: true,
            customerUsername: true,
            customerGstNo: true,
            billingAddress: true,
            billingPincode: true,
            fullAddress: true,
            installationAddress: true,
            poNumber: true,
            poExpiryDate: true,
            actualPlanName: true,
            actualPlanPrice: true,
            actualPlanBillingCycle: true,
            campaignData: {
              select: {
                company: true,
                name: true,
                phone: true,
                email: true,
                address: true,
                city: true,
                state: true
              }
            }
          }
        },
        payments: {
          orderBy: { paymentDate: 'desc' },
          include: {
            createdBy: { select: { id: true, name: true } }
          }
        },
        creditNotes: {
          orderBy: { createdAt: 'desc' },
          include: {
            createdBy: { select: { id: true, name: true } }
          }
        },
        createdBy: { select: { id: true, name: true } }
      }
    });

    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found.' });
    }

    res.json(invoice);
});

// ---------------------------------------------------------------------------
// 3. POST /generate/:leadId  -  generateInvoice
// ---------------------------------------------------------------------------
export const generateInvoice = asyncHandler(async function generateInvoice(req, res) {
    const { leadId } = req.params;
    const userId = req.user.id;

    if (!canAccessFinancials(req.user)) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: {
        id: true,
        actualPlanName: true,
        actualPlanPrice: true,
        actualPlanIsActive: true,
        customerUsername: true
      }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    if (!lead.actualPlanName || !lead.actualPlanPrice) {
      return res.status(400).json({ message: 'Lead does not have an active plan assigned.' });
    }

    if (!lead.actualPlanIsActive) {
      return res.status(400).json({ message: 'Plan is not active for this lead.' });
    }

    // Delegate to the shared job function which handles billing period calculation
    const invoice = await generateInvoiceForLead(leadId, userId);

    if (!invoice) {
      return res.status(400).json({ message: 'Invoice already exists for the current billing period.' });
    }

    emitSidebarRefreshByRole('ACCOUNTS_TEAM');
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.status(201).json({
      message: `Invoice ${invoice.invoiceNumber} generated successfully.`,
      data: invoice
    });
});

// ---------------------------------------------------------------------------
// 4. POST /generate-otc/:leadId  -  generateOTCInvoice
// ---------------------------------------------------------------------------
export const generateOTCInvoice = asyncHandler(async function generateOTCInvoice(req, res) {
  try {
    const { leadId } = req.params;
    const userId = req.user.id;

    if (!canAccessFinancials(req.user)) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      include: {
        campaignData: {
          select: { company: true, phone: true, email: true, address: true }
        }
      }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    // Use body amount if provided, otherwise fall back to lead's otcAmount
    const amount = req.body?.amount || lead.otcAmount;
    const description = req.body?.description;

    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Amount is required and must be greater than 0.' });
    }

    if (amount > 10000000) {
      return res.status(400).json({ message: 'Amount exceeds maximum allowed value.' });
    }

    // Check if OTC invoice already exists for this lead
    const existingOtc = await prisma.invoice.findFirst({
      where: {
        leadId,
        planName: 'One Time Charge (OTC)'
      }
    });

    // Use the existing OTC check inside a transaction for atomicity
    const result = await prisma.$transaction(async (tx) => {
      // Recheck inside transaction to avoid race condition
      const otcCheck = await tx.invoice.findFirst({
        where: {
          leadId,
          planName: 'One Time Charge (OTC)'
        }
      });

      if (otcCheck) {
        throw new Error('OTC_EXISTS');
      }

      const baseAmount = amount;
      const taxableAmount = baseAmount;
      const sgstRate = 9;
      const cgstRate = 9;
      const sgstAmount = (taxableAmount * sgstRate) / 100;
      const cgstAmount = (taxableAmount * cgstRate) / 100;
      const totalGstAmount = sgstAmount + cgstAmount;
      const grandTotal = taxableAmount + totalGstAmount;

      const invoiceNumber = await generateOTCInvoiceNumber();

      const invoiceDate = new Date();
      const dueDate = new Date(invoiceDate);
      dueDate.setUTCDate(dueDate.getUTCDate() + 15);

      const invoice = await tx.invoice.create({
        data: {
          invoiceNumber,
          leadId,
          invoiceDate,
          dueDate,
          billingPeriodStart: invoiceDate,
          billingPeriodEnd: invoiceDate,
          companyName: lead.campaignData?.company || 'Unknown',
          customerUsername: lead.customerUsername,
          billingAddress: lead.billingAddress || lead.fullAddress || lead.campaignData?.address,
          installationAddress: lead.installationAddress || lead.fullAddress,
          buyerGstNo: lead.customerGstNo,
          contactPhone: lead.campaignData?.phone,
          contactEmail: lead.campaignData?.email,
          poNumber: lead.poNumber,
          planName: 'One Time Charge (OTC)',
          planDescription: description || 'One Time Installation & Setup Charges',
          hsnSacCode: '998422',
          baseAmount,
          discountAmount: 0,
          taxableAmount,
          sgstRate,
          cgstRate,
          sgstAmount,
          cgstAmount,
          totalGstAmount,
          grandTotal,
          remainingAmount: grandTotal,
          status: 'GENERATED',
          notes: 'One Time Charge Invoice',
          createdById: userId
        }
      });

      // Link OTC invoice to lead
      await tx.lead.update({
        where: { id: leadId },
        data: {
          otcInvoiceId: invoice.id,
          otcInvoiceGeneratedAt: new Date()
        }
      });

      // Create ledger entry INSIDE transaction for consistency
      const lastEntry = await tx.ledgerEntry.findFirst({
        where: { customerId: leadId },
        orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
        select: { runningBalance: true }
      });
      const previousBalance = Number(lastEntry?.runningBalance) || 0;
      const periodLabel = invoiceDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      await tx.ledgerEntry.create({
        data: {
          customerId: leadId,
          entryDate: invoiceDate,
          entryType: 'INVOICE',
          referenceType: 'INVOICE',
          referenceId: invoice.id,
          referenceNumber: invoice.invoiceNumber,
          debitAmount: grandTotal,
          creditAmount: 0,
          runningBalance: previousBalance + grandTotal,
          description: `Invoice ${invoice.invoiceNumber} for billing period ${periodLabel} to ${periodLabel}`,
          createdById: userId
        }
      });

      return invoice;
    });

    emitSidebarRefreshByRole('ACCOUNTS_TEAM');
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.status(201).json({
      message: `OTC Invoice ${result.invoiceNumber} generated successfully.`,
      invoice: result
    });
  } catch (error) {
    if (error.message === 'OTC_EXISTS') {
      return res.status(400).json({ message: 'OTC invoice already exists for this lead.' });
    }
    throw error;
  }
});

// ---------------------------------------------------------------------------
// 5. PATCH /:id/status  -  updateInvoiceStatus
// ---------------------------------------------------------------------------
export const updateInvoiceStatus = asyncHandler(async function updateInvoiceStatus(req, res) {
    const { id } = req.params;
    const { status } = req.body;

    if (!canAccessFinancials(req.user)) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    // Only allow safe manual status transitions — PAID and CANCELLED must go
    // through proper payment/credit note workflows to maintain ledger integrity
    const safeStatuses = ['GENERATED', 'OVERDUE'];
    if (!status || !safeStatuses.includes(status)) {
      return res.status(400).json({
        message: `Manual status change only allowed to: ${safeStatuses.join(', ')}. Use payment or credit note workflows for PAID/CANCELLED.`
      });
    }

    const invoice = await prisma.invoice.findUnique({ where: { id } });
    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found.' });
    }

    if (invoice.status === 'PAID' || invoice.status === 'CANCELLED') {
      return res.status(400).json({ message: `Cannot change status of a ${invoice.status.toLowerCase()} invoice.` });
    }

    const updated = await prisma.invoice.update({
      where: { id },
      data: { status }
    });

    emitSidebarRefreshByRole('ACCOUNTS_TEAM');
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.json({ message: 'Invoice status updated.', data: updated });
});

// ---------------------------------------------------------------------------
// 6. POST /:id/pay  -  markInvoicePaid  (legacy full-payment)
// ---------------------------------------------------------------------------
export const markInvoicePaid = asyncHandler(async function markInvoicePaid(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    if (!canAccessFinancials(req.user)) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const {
      paymentMode,
      paymentReference,
      paymentRemark,
      provisionalReceiptNo,
      tdsAmount,
      transactionDate,
      paymentDiscount,
      bankAccount
    } = req.body;

    if (!paymentMode) {
      return res.status(400).json({ message: 'Payment mode is required.' });
    }

    const invoice = await prisma.invoice.findUnique({ where: { id } });
    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found.' });
    }

    if (invoice.status === 'PAID') {
      return res.status(400).json({ message: 'Invoice is already fully paid.' });
    }

    if (invoice.status === 'CANCELLED') {
      return res.status(400).json({ message: 'Cannot pay a cancelled invoice.' });
    }

    const receiptNumber = await generateReceiptNumber();
    const parsedTds = parseFloat(tdsAmount) || 0;
    const parsedDiscount = parseFloat(paymentDiscount) || 0;

    const result = await prisma.$transaction(async (tx) => {
      // Re-read inside transaction so we never compute payment amount from
      // stale grandTotal / totalPaidAmount / totalCreditAmount values. A
      // concurrent partial payment or credit note landing between the outer
      // read and the txn would otherwise cause over-credit on the ledger.
      const inv = await tx.invoice.findUnique({ where: { id } });
      if (!inv) throw new Error('NOT_FOUND');
      if (inv.status === 'PAID') throw new Error('ALREADY_PAID');
      if (inv.status === 'CANCELLED') throw new Error('CANCELLED');

      const existingPaid = inv.totalPaidAmount || 0;
      const creditAmount = inv.totalCreditAmount || 0;
      const paymentAmount = inv.grandTotal - creditAmount - existingPaid - parsedTds - parsedDiscount;

      if (paymentAmount < 0) throw new Error('OVERPAID');

      // Idempotency guard — same pattern as addPaymentToInvoice. Blocks
      // retried requests (double-tap, network retry) within a 60s window.
      const sixtySecondsAgo = new Date(Date.now() - 60 * 1000);
      const recentDuplicate = await tx.invoicePayment.findFirst({
        where: {
          invoiceId: id,
          amount: paymentAmount,
          paymentMode,
          createdById: userId,
          createdAt: { gte: sixtySecondsAgo },
        },
        select: { id: true, receiptNumber: true },
      });
      if (recentDuplicate) {
        const err = new Error('DUPLICATE_PAYMENT');
        err.existingReceipt = recentDuplicate.receiptNumber;
        throw err;
      }

      const payment = await tx.invoicePayment.create({
        data: {
          invoiceId: id,
          receiptNumber,
          paymentDate: transactionDate ? new Date(transactionDate) : new Date(),
          amount: paymentAmount,
          paymentMode,
          bankAccount: bankAccount || null,
          provisionalReceiptNo: provisionalReceiptNo || null,
          tdsAmount: parsedTds,
          transactionDate: transactionDate ? new Date(transactionDate) : new Date(),
          remark: paymentRemark || paymentReference || null,
          createdById: userId
        }
      });

      const totalPaid = existingPaid + paymentAmount + parsedTds;
      const remainingAmount = Math.max(0, inv.grandTotal - creditAmount - totalPaid);

      const updatedInvoice = await tx.invoice.update({
        where: { id },
        data: {
          status: 'PAID',
          paidAt: new Date(),
          paidAmount: paymentAmount,
          paymentMode,
          paymentReference: paymentReference || null,
          paymentRemark: paymentRemark || null,
          provisionalReceiptNo: provisionalReceiptNo || null,
          tdsAmount: parsedTds,
          transactionDate: transactionDate ? new Date(transactionDate) : null,
          paymentDiscount: parsedDiscount,
          totalPaidAmount: totalPaid,
          remainingAmount
        }
      });

      // Create ledger entry INSIDE transaction
      const lastEntry = await tx.ledgerEntry.findFirst({
        where: { customerId: updatedInvoice.leadId },
        orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
        select: { runningBalance: true }
      });
      const prevBalance = Number(lastEntry?.runningBalance) || 0;
      const creditTotal = (Number(payment.amount) || 0) + (Number(payment.tdsAmount) || 0);
      const modeMap = { CHEQUE: 'Cheque', NEFT: 'NEFT', ONLINE: 'Online Payment', TDS: 'TDS Deduction' };
      let desc = `Payment received via ${modeMap[payment.paymentMode] || payment.paymentMode}`;
      if (payment.tdsAmount > 0) desc += ` (Amount: ₹${payment.amount}, TDS: ₹${payment.tdsAmount})`;
      desc += ` against ${updatedInvoice.invoiceNumber || inv.invoiceNumber}`;
      await tx.ledgerEntry.create({
        data: {
          customerId: updatedInvoice.leadId,
          entryDate: payment.paymentDate || new Date(),
          entryType: 'PAYMENT',
          referenceType: 'PAYMENT',
          referenceId: payment.id,
          referenceNumber: payment.receiptNumber,
          debitAmount: 0,
          creditAmount: creditTotal,
          runningBalance: prevBalance - creditTotal,
          description: desc,
          createdById: userId
        }
      });

      return { payment, invoice: updatedInvoice };
    });

    emitSidebarRefreshByRole('ACCOUNTS_TEAM');
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.json({
      message: 'Invoice marked as paid.',
      data: result.invoice,
      payment: {
        receiptNumber: result.payment.receiptNumber,
        amount: result.payment.amount,
        tdsAmount: result.payment.tdsAmount
      }
    });
  } catch (error) {
    if (error.message === 'ALREADY_PAID') {
      return res.status(400).json({ message: 'Invoice is already fully paid.' });
    }
    if (error.message === 'NOT_FOUND') {
      return res.status(404).json({ message: 'Invoice not found.' });
    }
    if (error.message === 'CANCELLED') {
      return res.status(400).json({ message: 'Cannot pay a cancelled invoice.' });
    }
    if (error.message === 'OVERPAID') {
      return res.status(400).json({ message: 'Invoice already overpaid or fully credited.' });
    }
    if (error.message === 'DUPLICATE_PAYMENT') {
      return res.status(409).json({
        message: `A matching payment was just recorded (receipt ${error.existingReceipt}). If this is a genuine second payment, wait a moment and try again.`,
        existingReceipt: error.existingReceipt,
      });
    }
    throw error;
  }
});

// ---------------------------------------------------------------------------
// 7. POST /:id/payment  -  addPaymentToInvoice  (partial payment support)
// ---------------------------------------------------------------------------
export const addPaymentToInvoice = asyncHandler(async function addPaymentToInvoice(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    if (!canAccessFinancials(req.user)) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const {
      amount,
      paymentMode,
      bankAccount,
      provisionalReceiptNo,
      tdsAmount,
      transactionDate,
      remark
    } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Amount is required and must be greater than 0.' });
    }

    if (amount > 10000000) {
      return res.status(400).json({ message: 'Amount exceeds maximum allowed value.' });
    }

    if (!paymentMode) {
      return res.status(400).json({ message: 'Payment mode is required.' });
    }

    const validModes = ['CHEQUE', 'NEFT', 'ONLINE', 'TDS'];
    if (!validModes.includes(paymentMode)) {
      return res.status(400).json({ message: `Payment mode must be one of: ${validModes.join(', ')}` });
    }

    const receiptNumber = await generateReceiptNumber();
    const parsedTds = parseFloat(tdsAmount) || 0;
    const parsedAmount = parseFloat(amount);

    const result = await prisma.$transaction(async (tx) => {
      // Read inside transaction for serialized access
      const invoice = await tx.invoice.findUnique({ where: { id } });
      if (!invoice) {
        throw new Error('NOT_FOUND');
      }
      if (invoice.status === 'PAID') {
        throw new Error('ALREADY_PAID');
      }
      if (invoice.status === 'CANCELLED') {
        throw new Error('CANCELLED');
      }

      // Idempotency guard: protect against accidental duplicate submits from
      // the client (e.g. double-tapped save, network retry). If the same user
      // recorded a payment for this invoice with the same amount + mode
      // within the last 60 seconds, block as a likely duplicate rather than
      // creating two ledger entries. 60s is short enough not to flag a
      // deliberate same-day duplicate recorded hours apart.
      const sixtySecondsAgo = new Date(Date.now() - 60 * 1000);
      const recentDuplicate = await tx.invoicePayment.findFirst({
        where: {
          invoiceId: id,
          amount: parsedAmount,
          paymentMode,
          createdById: userId,
          createdAt: { gte: sixtySecondsAgo },
        },
        select: { id: true, receiptNumber: true },
      });
      if (recentDuplicate) {
        const err = new Error('DUPLICATE_PAYMENT');
        err.existingReceipt = recentDuplicate.receiptNumber;
        throw err;
      }

      // Calculate remaining
      const creditAmount = invoice.totalCreditAmount || 0;
      const existingPaid = invoice.totalPaidAmount || 0;
      const netPayable = invoice.grandTotal - creditAmount;
      const remainingBefore = netPayable - existingPaid;

      const totalPaymentCredit = parsedAmount + parsedTds;

      if (totalPaymentCredit > remainingBefore + 1) { // 1 rupee tolerance
        throw new Error('OVERPAYMENT');
      }

      const payment = await tx.invoicePayment.create({
        data: {
          invoiceId: id,
          receiptNumber,
          paymentDate: transactionDate ? new Date(transactionDate) : new Date(),
          amount: parsedAmount,
          paymentMode,
          bankAccount: bankAccount || null,
          provisionalReceiptNo: provisionalReceiptNo || null,
          tdsAmount: parsedTds,
          transactionDate: transactionDate ? new Date(transactionDate) : new Date(),
          remark: remark || null,
          createdById: userId
        }
      });

      const newTotalPaid = existingPaid + totalPaymentCredit;
      const newRemaining = Math.max(0, netPayable - newTotalPaid);

      // Determine new status
      let newStatus;
      if (newRemaining <= 1) { // 1 rupee tolerance
        newStatus = 'PAID';
      } else if (newTotalPaid > 0) {
        newStatus = 'PARTIALLY_PAID';
      } else {
        newStatus = invoice.status;
      }

      const updatedInvoice = await tx.invoice.update({
        where: { id },
        data: {
          totalPaidAmount: newTotalPaid,
          remainingAmount: newRemaining,
          status: newStatus,
          paidAt: newStatus === 'PAID' ? new Date() : invoice.paidAt
        }
      });

      // Create ledger entry INSIDE transaction
      const lastEntry = await tx.ledgerEntry.findFirst({
        where: { customerId: updatedInvoice.leadId },
        orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
        select: { runningBalance: true }
      });
      const prevBalance = Number(lastEntry?.runningBalance) || 0;
      const creditTotal = (Number(payment.amount) || 0) + (Number(payment.tdsAmount) || 0);
      const modeMap = { CHEQUE: 'Cheque', NEFT: 'NEFT', ONLINE: 'Online Payment', TDS: 'TDS Deduction' };
      let desc = `Payment received via ${modeMap[payment.paymentMode] || payment.paymentMode}`;
      if (payment.tdsAmount > 0) desc += ` (Amount: ₹${payment.amount}, TDS: ₹${payment.tdsAmount})`;
      desc += ` against ${updatedInvoice.invoiceNumber || invoice.invoiceNumber}`;
      await tx.ledgerEntry.create({
        data: {
          customerId: updatedInvoice.leadId,
          entryDate: payment.paymentDate || new Date(),
          entryType: 'PAYMENT',
          referenceType: 'PAYMENT',
          referenceId: payment.id,
          referenceNumber: payment.receiptNumber,
          debitAmount: 0,
          creditAmount: creditTotal,
          runningBalance: prevBalance - creditTotal,
          description: desc,
          createdById: userId
        }
      });

      return { payment, invoice: updatedInvoice };
    });

    emitSidebarRefreshByRole('ACCOUNTS_TEAM');
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.status(201).json({
      message: `Payment of Rs.${parsedAmount} recorded. Receipt: ${receiptNumber}`,
      payment: result.payment,
      invoice: {
        id: result.invoice.id,
        invoiceNumber: result.invoice.invoiceNumber,
        grandTotal: result.invoice.grandTotal,
        totalPaidAmount: result.invoice.totalPaidAmount,
        totalCreditAmount: result.invoice.totalCreditAmount,
        remainingAmount: result.invoice.remainingAmount,
        status: result.invoice.status
      }
    });
  } catch (error) {
    if (error.message === 'NOT_FOUND') {
      return res.status(404).json({ message: 'Invoice not found.' });
    }
    if (error.message === 'ALREADY_PAID') {
      return res.status(400).json({ message: 'Invoice is already fully paid.' });
    }
    if (error.message === 'CANCELLED') {
      return res.status(400).json({ message: 'Cannot pay a cancelled invoice.' });
    }
    if (error.message === 'OVERPAYMENT') {
      return res.status(400).json({ message: 'Payment amount exceeds remaining balance.' });
    }
    if (error.message === 'DUPLICATE_PAYMENT') {
      return res.status(409).json({
        message: `A matching payment was just recorded (receipt ${error.existingReceipt}). If this is a genuine second payment, wait a moment and try again.`,
        existingReceipt: error.existingReceipt,
      });
    }
    throw error;
  }
});

// ---------------------------------------------------------------------------
// 8. POST /bulk-pay  -  bulkPayInvoices
// ---------------------------------------------------------------------------
export const bulkPayInvoices = asyncHandler(async function bulkPayInvoices(req, res) {
    const userId = req.user.id;

    if (!canAccessFinancials(req.user)) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const { invoiceIds, paymentMode, bankAccount, transactionDate, remark } = req.body;

    if (!invoiceIds || !Array.isArray(invoiceIds) || invoiceIds.length === 0) {
      return res.status(400).json({ message: 'At least one invoice ID is required.' });
    }

    if (!paymentMode) {
      return res.status(400).json({ message: 'Payment mode is required.' });
    }

    // ─── Phase 1: pre-validate ALL invoices before touching the DB ────────
    // If any invoice is in a bad state, fail the whole batch early so we
    // never commit a partial set of payments. This is the financial
    // correctness fix — previously each invoice ran in its own tx, so an
    // error on invoice 5 would leave invoices 1-4 paid + ledger-entered
    // and invoice 5+ untouched, creating a reconcilable mess.
    const plannedPayments = [];
    const validationErrors = [];
    for (const invoiceId of invoiceIds) {
      const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) {
        validationErrors.push({ invoiceId, error: 'Invoice not found' });
        continue;
      }
      if (invoice.status === 'PAID' || invoice.status === 'CANCELLED') {
        validationErrors.push({ invoiceId, error: `Invoice is ${invoice.status.toLowerCase()}` });
        continue;
      }
      const creditAmount = invoice.totalCreditAmount || 0;
      const existingPaid = invoice.totalPaidAmount || 0;
      const netPayable = invoice.grandTotal - creditAmount;
      const remaining = netPayable - existingPaid;
      if (remaining <= 0) {
        validationErrors.push({ invoiceId, error: 'No remaining amount' });
        continue;
      }
      plannedPayments.push({ invoice, existingPaid, remaining });
    }

    if (validationErrors.length > 0) {
      return res.status(400).json({
        message: `Cannot bulk-pay — ${validationErrors.length} invoice(s) failed validation. No payments recorded.`,
        errors: validationErrors,
      });
    }

    // ─── Phase 2: generate receipt numbers (outside tx — fine if tx rolls back,
    // sequence can have gaps; receipt numbers are write-only from this point)
    const planWithReceipts = [];
    for (const p of plannedPayments) {
      planWithReceipts.push({ ...p, receiptNumber: await generateReceiptNumber() });
    }

    // ─── Phase 3: ALL-OR-NOTHING writes in one transaction ────────────────
    let results;
    try {
      results = await prisma.$transaction(async (tx) => {
        const out = [];
        const ledgerCursorByCustomer = new Map(); // keep per-customer running balance cursor in one pass

        for (const { invoice, existingPaid, remaining, receiptNumber } of planWithReceipts) {
          const payment = await tx.invoicePayment.create({
            data: {
              invoiceId: invoice.id,
              receiptNumber,
              paymentDate: transactionDate ? new Date(transactionDate) : new Date(),
              amount: remaining,
              paymentMode,
              bankAccount: bankAccount || null,
              tdsAmount: 0,
              transactionDate: transactionDate ? new Date(transactionDate) : new Date(),
              remark: remark || 'Bulk payment',
              createdById: userId,
            },
          });

          const updatedInvoice = await tx.invoice.update({
            where: { id: invoice.id },
            data: {
              totalPaidAmount: existingPaid + remaining,
              remainingAmount: 0,
              status: 'PAID',
              paidAt: new Date(),
            },
          });

          // Ledger: use cached cursor if this customer already had a balance
          // updated in this same tx, else read the last entry from DB.
          let prevBal;
          if (ledgerCursorByCustomer.has(updatedInvoice.leadId)) {
            prevBal = ledgerCursorByCustomer.get(updatedInvoice.leadId);
          } else {
            const lastEntry = await tx.ledgerEntry.findFirst({
              where: { customerId: updatedInvoice.leadId },
              orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
              select: { runningBalance: true },
            });
            prevBal = Number(lastEntry?.runningBalance) || 0;
          }
          const newBal = prevBal - (Number(payment.amount) || 0);
          ledgerCursorByCustomer.set(updatedInvoice.leadId, newBal);

          await tx.ledgerEntry.create({
            data: {
              customerId: updatedInvoice.leadId,
              entryDate: payment.paymentDate || new Date(),
              entryType: 'PAYMENT',
              referenceType: 'PAYMENT',
              referenceId: payment.id,
              referenceNumber: payment.receiptNumber,
              debitAmount: 0,
              creditAmount: Number(payment.amount) || 0,
              runningBalance: newBal,
              description: `Payment received via ${paymentMode} against ${updatedInvoice.invoiceNumber}`,
              createdById: userId,
            },
          });

          out.push({
            invoiceId: invoice.id,
            invoiceNumber: updatedInvoice.invoiceNumber,
            receiptNumber: payment.receiptNumber,
            amount: payment.amount,
            status: 'success',
          });
        }
        return out;
      }, { timeout: 30000 });
    } catch (err) {
      console.error('[bulkPayInvoices] transaction failed, rolling back:', err);
      return res.status(500).json({
        message: 'Bulk payment failed mid-way; no payments recorded. Please retry.',
        error: err?.message,
      });
    }

    emitSidebarRefreshByRole('ACCOUNTS_TEAM');
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.json({
      message: `${results.length} invoice(s) paid successfully.`,
      data: { results, errors: [] },
    });
});

// ---------------------------------------------------------------------------
// 9. GET /leads/invoiceable  -  getInvoiceableLeads
// ---------------------------------------------------------------------------
export const getInvoiceableLeads = asyncHandler(async function getInvoiceableLeads(req, res) {
    const { page, limit, skip } = parsePagination(req.query, 25);

    const where = {
      actualPlanName: { not: null },
      actualPlanPrice: { not: null },
      actualPlanIsActive: true
    };

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        select: {
          id: true,
          customerUsername: true,
          actualPlanName: true,
          actualPlanPrice: true,
          actualPlanBillingCycle: true,
          actualPlanStartDate: true,
          actualPlanIsActive: true,
          billingAddress: true,
          customerGstNo: true,
          campaignData: {
            select: { company: true, name: true, phone: true, email: true }
          },
          invoices: {
            where: { planName: { not: 'One Time Charge (OTC)' } },
            orderBy: { billingPeriodEnd: 'desc' },
            take: 1,
            select: {
              id: true,
              invoiceNumber: true,
              billingPeriodStart: true,
              billingPeriodEnd: true,
              status: true
            }
          }
        },
        orderBy: { actualPlanCreatedAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.lead.count({ where })
    ]);

    res.json(paginatedResponse({ data: leads, total, page, limit }));
});

// ---------------------------------------------------------------------------
// 10. GET /lead/:leadId  -  getLeadInvoices
// ---------------------------------------------------------------------------
export const getLeadInvoices = asyncHandler(async function getLeadInvoices(req, res) {
    const { leadId } = req.params;
    const { page, limit, skip } = parsePagination(req.query, 50);

    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: {
        id: true,
        customerUsername: true,
        actualPlanName: true,
        actualPlanPrice: true,
        campaignData: {
          select: { company: true, name: true, phone: true, email: true }
        }
      }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    const where = { leadId };

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        select: {
          id: true,
          invoiceNumber: true,
          invoiceDate: true,
          dueDate: true,
          billingPeriodStart: true,
          billingPeriodEnd: true,
          planName: true,
          baseAmount: true,
          grandTotal: true,
          status: true,
          totalPaidAmount: true,
          totalCreditAmount: true,
          remainingAmount: true,
          createdAt: true
        },
        orderBy: { invoiceDate: 'desc' },
        skip,
        take: limit
      }),
      prisma.invoice.count({ where })
    ]);

    // Summary
    const summary = await prisma.invoice.aggregate({
      where: { leadId },
      _sum: {
        grandTotal: true,
        totalPaidAmount: true,
        totalCreditAmount: true
      },
      _count: { id: true }
    });

    res.json(paginatedResponse({
      data: invoices,
      total,
      page,
      limit,
      extra: {
        lead,
        summary: {
          totalInvoiced: summary._sum.grandTotal || 0,
          totalPaid: summary._sum.totalPaidAmount || 0,
          totalCredit: summary._sum.totalCreditAmount || 0,
          outstandingBalance: (summary._sum.grandTotal || 0) - (summary._sum.totalPaidAmount || 0) - (summary._sum.totalCreditAmount || 0),
          invoiceCount: summary._count.id
        }
      }
    }));
});

// ---------------------------------------------------------------------------
// 11. GET /customers/pending  -  getCustomersWithPendingInvoices
// ---------------------------------------------------------------------------
// Shows all customers (leads with active plans OR any invoices).
// Supports filter=all|pending|partial|paid, search, dateFrom/dateTo.
// Returns { customers, stats, pagination } matching the billing-mgmt frontend.
// ---------------------------------------------------------------------------
export const getCustomersWithPendingInvoices = asyncHandler(async function getCustomersWithPendingInvoices(req, res) {
    const { page, limit, skip } = parsePagination(req.query, 25);
    const { search, filter = 'all', dateFrom, dateTo } = req.query;

    // Base: leads with an active plan OR at least one non-cancelled invoice
    const baseWhere = {
      OR: [
        { actualPlanIsActive: true },
        { invoices: { some: { status: { not: 'CANCELLED' } } } }
      ]
    };

    const searchOR = buildSearchFilter(search, [
      'customerUsername',
      'campaignData.company',
      'campaignData.name',
      'campaignData.phone'
    ]);
    if (searchOR) {
      baseWhere.AND = [{ OR: searchOR }];
    }

    // Date filter on invoices
    const invoiceDateFilter = {};
    if (dateFrom) {
      const start = new Date(dateFrom);
      start.setHours(0, 0, 0, 0);
      invoiceDateFilter.createdAt = { ...invoiceDateFilter.createdAt, gte: start };
    }
    if (dateTo) {
      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);
      invoiceDateFilter.createdAt = { ...invoiceDateFilter.createdAt, lte: end };
    }

    // Fetch matching leads WITHOUT their invoices. Loading every invoice for
    // every matching customer into Node memory was a scalability bomb at
    // ~1000 customers × 12 invoices = 12K rows per page load. We now pull
    // per-lead invoice aggregates in a single groupBy query below, which is
    // bounded by (lead count × status count) rather than total invoices.
    const allLeads = await prisma.lead.findMany({
      where: baseWhere,
      select: {
        id: true,
        customerUsername: true,
        actualPlanName: true,
        actualPlanPrice: true,
        actualPlanIsActive: true,
        otcAmount: true,
        otcInvoiceId: true,
        customerGstNo: true,
        campaignData: {
          select: { company: true, name: true, phone: true, email: true }
        }
      },
      orderBy: { updatedAt: 'desc' }
    });

    const leadIds = allLeads.map((l) => l.id);

    // Per-lead, per-status aggregation replaces the in-memory reduce/filter
    // loops below. Prisma's _sum treats NULL as 0; this matches the original
    // behavior for totalAmount / totalPaidAmount, and is a near-equivalent
    // for totalPendingAmount since Invoice.remainingAmount is populated on
    // create and on every payment. Legacy rows with NULL remainingAmount (if
    // any) will contribute 0 instead of (grandTotal - totalPaidAmount); this
    // is a minor discrepancy compared to the memory exposure of the old code.
    const invoiceAgg = leadIds.length
      ? await prisma.invoice.groupBy({
          by: ['leadId', 'status'],
          where: {
            leadId: { in: leadIds },
            status: { not: 'CANCELLED' },
            ...invoiceDateFilter
          },
          _count: { id: true },
          _sum: {
            grandTotal: true,
            totalPaidAmount: true,
            remainingAmount: true
          },
          _min: { dueDate: true },
          _max: { dueDate: true }
        })
      : [];

    // Collapse { leadId, status } rows into per-lead rollups.
    const byLead = new Map();
    const PENDING_DUE_STATUSES = new Set(['GENERATED', 'PARTIALLY_PAID', 'OVERDUE']);
    for (const row of invoiceAgg) {
      const entry = byLead.get(row.leadId) || {
        invoiceCount: 0,
        pendingCount: 0,    // GENERATED + OVERDUE
        partialCount: 0,    // PARTIALLY_PAID
        paidCount: 0,       // PAID
        totalAmount: 0,
        totalPaidAmount: 0,
        totalPendingAmount: 0,
        oldestPendingDueDate: null,
        latestPaidDueDate: null
      };
      const count = row._count.id || 0;
      entry.invoiceCount += count;
      entry.totalAmount += Number(row._sum.grandTotal || 0);
      entry.totalPaidAmount += Number(row._sum.totalPaidAmount || 0);
      entry.totalPendingAmount += Number(row._sum.remainingAmount || 0);

      if (row.status === 'GENERATED' || row.status === 'OVERDUE') {
        entry.pendingCount += count;
      } else if (row.status === 'PARTIALLY_PAID') {
        entry.partialCount += count;
      } else if (row.status === 'PAID') {
        entry.paidCount += count;
        if (row._max.dueDate && (!entry.latestPaidDueDate || row._max.dueDate > entry.latestPaidDueDate)) {
          entry.latestPaidDueDate = row._max.dueDate;
        }
      }

      if (PENDING_DUE_STATUSES.has(row.status) && row._min.dueDate) {
        if (!entry.oldestPendingDueDate || row._min.dueDate < entry.oldestPendingDueDate) {
          entry.oldestPendingDueDate = row._min.dueDate;
        }
      }

      byLead.set(row.leadId, entry);
    }

    // Compute per-customer metrics from the aggregate map.
    const enriched = allLeads.map((lead) => {
      const agg = byLead.get(lead.id);
      const invoiceCount = agg?.invoiceCount || 0;
      const pendingCount = agg?.pendingCount || 0;
      const partialCount = agg?.partialCount || 0;
      const paidCount = agg?.paidCount || 0;

      // Determine payment status category — identical logic to the previous
      // per-invoice implementation, just driven by pre-aggregated counts.
      let paymentCategory = 'all';
      if (invoiceCount === 0) {
        paymentCategory = 'pending';
      } else if (pendingCount > 0 && paidCount === 0 && partialCount === 0) {
        paymentCategory = 'pending';
      } else if (partialCount > 0) {
        paymentCategory = 'partial';
      } else if (paidCount > 0 && pendingCount === 0 && partialCount === 0) {
        paymentCategory = 'paid';
      } else {
        paymentCategory = 'pending';
      }

      return {
        leadId: lead.id,
        customerUsername: lead.customerUsername,
        companyName: lead.campaignData?.company || lead.customerUsername || 'N/A',
        contactName: lead.campaignData?.name || '-',
        contactPhone: lead.campaignData?.phone || '',
        contactEmail: lead.campaignData?.email || '',
        planName: lead.actualPlanName,
        planPrice: lead.actualPlanPrice,
        isActive: lead.actualPlanIsActive,
        otcAmount: lead.otcAmount || 0,
        otcInvoiceId: lead.otcInvoiceId || null,
        invoiceCount,
        pendingCount: pendingCount + partialCount,
        totalAmount: agg?.totalAmount || 0,
        totalPaidAmount: agg?.totalPaidAmount || 0,
        totalPendingAmount: Math.max(0, agg?.totalPendingAmount || 0),
        oldestDueDate: agg?.oldestPendingDueDate || null,
        lastPaidDate: agg?.latestPaidDueDate || null,
        paymentCategory
      };
    });

    // Apply filter
    let filtered = enriched;
    if (filter === 'pending') {
      filtered = enriched.filter(c => c.paymentCategory === 'pending');
    } else if (filter === 'partial') {
      filtered = enriched.filter(c => c.paymentCategory === 'partial');
    } else if (filter === 'paid') {
      filtered = enriched.filter(c => c.paymentCategory === 'paid');
    }

    // Stats (computed from all enriched, before filter-based pagination)
    const allStats = {
      totalCustomers: filtered.length,
      totalInvoices: filtered.reduce((s, c) => s + c.invoiceCount, 0),
      totalAmount: filtered.reduce((s, c) => s + c.totalAmount, 0),
      totalPaidAmount: filtered.reduce((s, c) => s + c.totalPaidAmount, 0),
      totalPendingAmount: filtered.reduce((s, c) => s + c.totalPendingAmount, 0),
      // Tab counts (always from full list, unfiltered)
      allTabCount: enriched.length,
      pendingTabCount: enriched.filter(c => c.paymentCategory === 'pending').length,
      partialTabCount: enriched.filter(c => c.paymentCategory === 'partial').length,
      paidTabCount: enriched.filter(c => c.paymentCategory === 'paid').length
    };

    // Paginate
    const total = filtered.length;
    const paginated = filtered.slice(skip, skip + limit);

    res.json(paginatedResponse({
      data: paginated,
      total,
      page,
      limit,
      dataKey: 'customers',
      extra: { stats: allStats }
    }));
});

// ---------------------------------------------------------------------------
// 12. GET /customer/:leadId  -  getCustomerInvoiceDetail
// ---------------------------------------------------------------------------
export const getCustomerInvoiceDetail = asyncHandler(async function getCustomerInvoiceDetail(req, res) {
    const { leadId } = req.params;

    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: {
        id: true,
        customerUsername: true,
        customerUserId: true,
        customerGstNo: true,
        customerLegalName: true,
        billingAddress: true,
        billingPincode: true,
        installationAddress: true,
        installationPincode: true,
        fullAddress: true,
        actualPlanName: true,
        actualPlanPrice: true,
        actualPlanBillingCycle: true,
        actualPlanStartDate: true,
        actualPlanEndDate: true,
        actualPlanIsActive: true,
        otcAmount: true,
        otcInvoiceId: true,
        arcAmount: true,
        advanceAmount: true,
        panCardNo: true,
        tanNumber: true,
        poNumber: true,
        poExpiryDate: true,
        billDate: true,
        technicalInchargeMobile: true,
        technicalInchargeEmail: true,
        accountsInchargeMobile: true,
        accountsInchargeEmail: true,
        bdmName: true,
        serviceManager: true,
        campaignData: {
          select: {
            company: true,
            name: true,
            firstName: true,
            lastName: true,
            phone: true,
            email: true,
            address: true,
            city: true,
            state: true
          }
        },
        assignedTo: { select: { id: true, name: true } }
      }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    // Get all invoices
    const invoices = await prisma.invoice.findMany({
      where: { leadId },
      select: {
        id: true,
        invoiceNumber: true,
        invoiceDate: true,
        dueDate: true,
        billingPeriodStart: true,
        billingPeriodEnd: true,
        planName: true,
        companyName: true,
        customerUsername: true,
        billingAddress: true,
        buyerGstNo: true,
        baseAmount: true,
        taxableAmount: true,
        sgstAmount: true,
        cgstAmount: true,
        totalGstAmount: true,
        grandTotal: true,
        status: true,
        totalPaidAmount: true,
        totalCreditAmount: true,
        remainingAmount: true,
        notes: true,
        createdAt: true,
        payments: {
          orderBy: { paymentDate: 'desc' },
          select: {
            id: true,
            receiptNumber: true,
            paymentDate: true,
            amount: true,
            paymentMode: true,
            tdsAmount: true,
            remark: true
          }
        },
        creditNotes: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            creditNoteNumber: true,
            totalAmount: true,
            reason: true,
            status: true,
            createdAt: true
          }
        }
      },
      orderBy: { invoiceDate: 'desc' }
    });

    // Advance payments
    const advancePayments = await prisma.advancePayment.findMany({
      where: { leadId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        receiptNumber: true,
        amount: true,
        paymentMode: true,
        transactionDate: true,
        remark: true,
        createdAt: true
      }
    });

    // Summary calculations
    const totalInvoiced = invoices.reduce((sum, inv) => sum + inv.grandTotal, 0);
    const totalPaid = invoices.reduce((sum, inv) => sum + (inv.totalPaidAmount || 0), 0);
    const totalCredit = invoices.reduce((sum, inv) => sum + (inv.totalCreditAmount || 0), 0);
    const totalAdvance = advancePayments.reduce((sum, ap) => sum + ap.amount, 0);

    // Flatten customer for frontend (expects companyName, contactPhone, etc.)
    const customer = {
      ...lead,
      companyName: lead.campaignData?.company || lead.customerUsername || 'N/A',
      contactName: lead.campaignData?.name || `${lead.campaignData?.firstName || ''} ${lead.campaignData?.lastName || ''}`.trim() || '-',
      contactPhone: lead.campaignData?.phone || '-',
      contactEmail: lead.campaignData?.email || '-',
      city: lead.campaignData?.city || lead.campaignData?.state || '-',
      address: lead.campaignData?.address || '-'
    };

    const pendingCount = invoices.filter((i) => ['GENERATED', 'PARTIALLY_PAID', 'OVERDUE'].includes(i.status)).length;
    const totalPendingAmount = totalInvoiced - totalPaid - totalCredit;

    res.json({
      customer,
      invoices,
      advancePayments,
      summary: {
        totalInvoiced,
        totalPaid,
        totalPaidAmount: totalPaid,
        totalCredit,
        totalCreditAmount: totalCredit,
        totalAdvance,
        outstandingBalance: totalPendingAmount,
        totalPendingAmount,
        invoiceCount: invoices.length,
        pendingInvoices: pendingCount,
        pendingCount,
        paidInvoices: invoices.filter((i) => i.status === 'PAID').length
      }
    });
});

// ---------------------------------------------------------------------------
// 13. DELETE /:id  -  deleteInvoice
// ---------------------------------------------------------------------------
export const deleteInvoice = asyncHandler(async function deleteInvoice(req, res) {
    const { id } = req.params;

    // Sales directors have view parity with super admin elsewhere but must
    // not be able to wipe invoices (and the ledger rows they anchor).
    if (!canHardDelete(req.user)) {
      return res.status(403).json({ message: 'Only super admins can delete invoices.' });
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: {
        payments: true,
        creditNotes: true
      }
    });

    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found.' });
    }

    if (invoice.payments.length > 0) {
      return res.status(400).json({
        message: 'Cannot delete invoice with existing payments. Remove payments first.'
      });
    }

    if (invoice.creditNotes.length > 0) {
      return res.status(400).json({
        message: 'Cannot delete invoice with existing credit notes. Remove credit notes first.'
      });
    }

    await prisma.$transaction(async (tx) => {
      // Delete the invoice
      await tx.invoice.delete({ where: { id } });

      // If it was an OTC invoice, clear the reference on the lead
      if (invoice.planName === 'One Time Charge (OTC)') {
        await tx.lead.updateMany({
          where: { otcInvoiceId: id },
          data: { otcInvoiceId: null, otcInvoiceGeneratedAt: null }
        });
      }

      // Ledger cleanup must be atomic with the invoice delete — otherwise a
      // crash between the two leaves an orphan debit entry on the customer's
      // ledger that no amount of retrying can reconcile.
      await deleteLedgerEntriesForInvoice(id, invoice.leadId, tx);
    }, { isolationLevel: 'Serializable' });

    emitSidebarRefreshByRole('ACCOUNTS_TEAM');
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.json({ message: `Invoice ${invoice.invoiceNumber} deleted successfully.` });
});

// ---------------------------------------------------------------------------
// 14. POST /customer/:leadId/advance-payment  -  recordAdvancePayment
// ---------------------------------------------------------------------------
export const recordAdvancePayment = asyncHandler(async function recordAdvancePayment(req, res) {
    const { leadId } = req.params;
    const userId = req.user.id;

    if (!canAccessFinancials(req.user)) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const { amount, paymentMode, bankAccount, provisionalReceiptNo, transactionDate, remark } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Amount is required and must be greater than 0.' });
    }

    if (amount > 10000000) {
      return res.status(400).json({ message: 'Amount exceeds maximum allowed value.' });
    }

    if (!paymentMode) {
      return res.status(400).json({ message: 'Payment mode is required.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, customerUsername: true }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    const receiptNumber = await generateAdvancePaymentNumber();
    const parsedAmount = parseFloat(amount);
    const txnDate = transactionDate ? new Date(transactionDate) : new Date();

    const advancePayment = await prisma.$transaction(async (tx) => {
      const ap = await tx.advancePayment.create({
        data: {
          receiptNumber,
          leadId,
          amount: parsedAmount,
          paymentMode,
          bankAccount: bankAccount || null,
          provisionalReceiptNo: provisionalReceiptNo || null,
          transactionDate: txnDate,
          remark: remark || null,
          createdById: userId
        }
      });

      // Create ledger entry INSIDE transaction
      const lastEntry = await tx.ledgerEntry.findFirst({
        where: { customerId: leadId },
        orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
        select: { runningBalance: true }
      });
      const prevBalance = Number(lastEntry?.runningBalance) || 0;

      await tx.ledgerEntry.create({
        data: {
          customerId: leadId,
          entryDate: txnDate,
          entryType: 'PAYMENT',
          referenceType: 'ADVANCE_PAYMENT',
          referenceId: ap.id,
          referenceNumber: receiptNumber,
          debitAmount: 0,
          creditAmount: parsedAmount,
          runningBalance: prevBalance - parsedAmount,
          description: `Advance payment received via ${paymentMode} - ${receiptNumber}`,
          createdById: userId
        }
      });

      return ap;
    });

    emitSidebarRefreshByRole('ACCOUNTS_TEAM');
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.status(201).json({
      message: `Advance payment of Rs.${amount} recorded. Receipt: ${receiptNumber}`,
      data: advancePayment
    });
});

// ---------------------------------------------------------------------------
// 15. GET /customer/:leadId/advance-balance  -  getCustomerAdvanceBalance
// ---------------------------------------------------------------------------
export const getCustomerAdvanceBalance = asyncHandler(async function getCustomerAdvanceBalance(req, res) {
    const { leadId } = req.params;

    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: {
        id: true,
        customerUsername: true,
        campaignData: { select: { company: true } }
      }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    // Total advance payments
    const advanceTotal = await prisma.advancePayment.aggregate({
      where: { leadId },
      _sum: { amount: true },
      _count: { id: true }
    });

    // Get all advance payments
    const advancePayments = await prisma.advancePayment.findMany({
      where: { leadId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        receiptNumber: true,
        amount: true,
        paymentMode: true,
        transactionDate: true,
        remark: true,
        createdAt: true
      }
    });

    res.json({
      data: {
        leadId,
        customerUsername: lead.customerUsername,
        companyName: lead.campaignData?.company || 'Unknown',
        totalAdvanceAmount: advanceTotal._sum.amount || 0,
        advancePaymentCount: advanceTotal._count.id || 0,
        advancePayments
      }
    });
});

// ---------------------------------------------------------------------------
// 16. POST /customer/:leadId/settle-advance  -  settleAdvanceAgainstInvoice
// ---------------------------------------------------------------------------
export const settleAdvanceAgainstInvoice = asyncHandler(async function settleAdvanceAgainstInvoice(req, res) {
  try {
    const { leadId } = req.params;
    const userId = req.user.id;

    if (!canAccessFinancials(req.user)) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const { invoiceId, amount } = req.body;

    if (!invoiceId) {
      return res.status(400).json({ message: 'Invoice ID is required.' });
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Amount is required and must be greater than 0.' });
    }

    // Verify lead exists
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    // Verify invoice belongs to this lead
    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, leadId }
    });

    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found for this customer.' });
    }

    if (invoice.status === 'PAID') {
      return res.status(400).json({ message: 'Invoice is already fully paid.' });
    }

    if (invoice.status === 'CANCELLED') {
      return res.status(400).json({ message: 'Cannot settle against a cancelled invoice.' });
    }

    const receiptNumber = await generateReceiptNumber();

    const result = await prisma.$transaction(async (tx) => {
      // Re-read invoice inside transaction
      const inv = await tx.invoice.findUnique({ where: { id: invoiceId } });
      if (inv.status === 'PAID') {
        throw new Error('ALREADY_PAID');
      }

      // Re-check advance balance INSIDE transaction to prevent TOCTOU race
      const advanceTotal = await tx.advancePayment.aggregate({
        where: { leadId },
        _sum: { amount: true }
      });
      const totalAdvance = advanceTotal._sum.amount || 0;
      if (amount > totalAdvance) {
        throw new Error('INSUFFICIENT_ADVANCE');
      }

      // Check remaining on invoice
      const invCreditAmount = inv.totalCreditAmount || 0;
      const existingPaid = inv.totalPaidAmount || 0;
      const remaining = inv.grandTotal - invCreditAmount - existingPaid;
      const settleAmount = Math.min(parseFloat(amount), remaining);

      // Create payment against invoice
      const payment = await tx.invoicePayment.create({
        data: {
          invoiceId,
          receiptNumber,
          paymentDate: new Date(),
          amount: settleAmount,
          paymentMode: 'ADVANCE_SETTLEMENT',
          tdsAmount: 0,
          remark: `Settled from advance balance`,
          createdById: userId
        }
      });

      // Update invoice
      const newTotalPaid = existingPaid + settleAmount;
      const newRemaining = Math.max(0, inv.grandTotal - invCreditAmount - newTotalPaid);
      let newStatus;
      if (newRemaining <= 1) {
        newStatus = 'PAID';
      } else if (newTotalPaid > 0) {
        newStatus = 'PARTIALLY_PAID';
      } else {
        newStatus = inv.status;
      }

      const updatedInvoice = await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          totalPaidAmount: newTotalPaid,
          remainingAmount: newRemaining,
          status: newStatus,
          paidAt: newStatus === 'PAID' ? new Date() : inv.paidAt
        }
      });

      // Create a negative advance payment to reduce balance
      const deductionReceipt = `ADV-SETTLE-${Date.now()}`;
      await tx.advancePayment.create({
        data: {
          receiptNumber: deductionReceipt,
          leadId,
          amount: -settleAmount,
          paymentMode: 'ADVANCE_SETTLEMENT',
          remark: `Settled against invoice ${inv.invoiceNumber}`,
          createdById: userId
        }
      });

      // Create ledger entry INSIDE transaction
      const lastEntry = await tx.ledgerEntry.findFirst({
        where: { customerId: leadId },
        orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
        select: { runningBalance: true }
      });
      const prevBalance = Number(lastEntry?.runningBalance) || 0;
      await tx.ledgerEntry.create({
        data: {
          customerId: leadId,
          entryDate: new Date(),
          entryType: 'PAYMENT',
          referenceType: 'PAYMENT',
          referenceId: payment.id,
          referenceNumber: payment.receiptNumber,
          debitAmount: 0,
          creditAmount: settleAmount,
          runningBalance: prevBalance - settleAmount,
          description: `Advance settlement against ${inv.invoiceNumber}`,
          createdById: userId
        }
      });

      return { payment, invoice: updatedInvoice, settleAmount };
    });

    emitSidebarRefreshByRole('ACCOUNTS_TEAM');
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.json({
      message: `Rs.${result.settleAmount} settled from advance against invoice ${result.invoice.invoiceNumber}.`,
      data: {
        payment: result.payment,
        invoice: {
          id: result.invoice.id,
          invoiceNumber: result.invoice.invoiceNumber,
          grandTotal: result.invoice.grandTotal,
          totalPaidAmount: result.invoice.totalPaidAmount,
          remainingAmount: result.invoice.remainingAmount,
          status: result.invoice.status
        }
      }
    });
  } catch (error) {
    if (error.message === 'ALREADY_PAID') {
      return res.status(400).json({ message: 'Invoice is already fully paid.' });
    }
    if (error.message === 'INSUFFICIENT_ADVANCE') {
      return res.status(400).json({ message: 'Insufficient advance balance.' });
    }
    throw error;
  }
});

// ---------------------------------------------------------------------------
// 17. GET /:id/payments  -  getInvoicePayments
// ---------------------------------------------------------------------------
export const getInvoicePayments = asyncHandler(async function getInvoicePayments(req, res) {
    const { id } = req.params;

    const invoice = await prisma.invoice.findUnique({
      where: { id },
      select: {
        id: true,
        invoiceNumber: true,
        companyName: true,
        grandTotal: true,
        totalPaidAmount: true,
        totalCreditAmount: true,
        remainingAmount: true,
        status: true
      }
    });

    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found.' });
    }

    const payments = await prisma.invoicePayment.findMany({
      where: { invoiceId: id },
      orderBy: { paymentDate: 'desc' },
      include: {
        createdBy: { select: { id: true, name: true } }
      }
    });

    res.json({
      invoice,
      payments,
      summary: {
        totalPayments: payments.length,
        totalPaidAmount: payments.reduce((sum, p) => sum + (p.amount || 0) + (p.tdsAmount || 0), 0)
      }
    });
});

// ---------------------------------------------------------------------------
// 18. POST /auto-generate  -  autoGenerateInvoices
// ---------------------------------------------------------------------------
export const autoGenerateInvoices = asyncHandler(async function autoGenerateInvoices(req, res) {
    if (!canAccessFinancials(req.user)) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const userId = req.user.id;

    // Serialize against the daily cron — running both concurrently causes
    // duplicate invoices (invoiceExistsForPeriod check is non-transactional).
    const lockResult = await withInvoiceJobLock(`manual:${userId}`, async () => {
      const leadsWithActivePlans = await prisma.lead.findMany({
        where: {
          actualPlanName: { not: null },
          actualPlanPrice: { not: null },
          actualPlanIsActive: true
        },
        select: {
          id: true,
          customerUsername: true,
          actualPlanName: true,
          actualPlanPrice: true,
          campaignData: { select: { company: true } }
        }
      });

      let generated = 0;
      let skipped = 0;
      const results = [];

      for (const lead of leadsWithActivePlans) {
        try {
          const invoice = await generateInvoiceForLead(lead.id, userId);
          if (invoice) {
            generated++;
            results.push({
              leadId: lead.id,
              company: lead.campaignData?.company,
              invoiceNumber: invoice.invoiceNumber,
              amount: invoice.grandTotal
            });
          } else {
            skipped++;
          }
        } catch (err) {
          console.error(`Auto-generate failed for lead ${lead.id}:`, err.message);
          skipped++;
        }
      }

      return { generated, skipped, total: leadsWithActivePlans.length, results };
    });

    if (!lockResult.acquired) {
      return res.status(409).json({
        message: 'Invoice generation is already running. Please wait a moment and try again.',
      });
    }

    const { generated, skipped, total, results } = lockResult.result;

    if (generated > 0) {
      emitSidebarRefreshByRole('ACCOUNTS_TEAM');
      emitSidebarRefreshByRole('SUPER_ADMIN');
    }

    res.json({
      message: `Generated ${generated} invoice(s). Skipped ${skipped}.`,
      data: {
        generated,
        skipped,
        total,
        invoices: results
      }
    });
});

// ---------------------------------------------------------------------------
// 19. GET /auto-generate/check  -  checkPendingInvoices
// ---------------------------------------------------------------------------
export const checkPendingInvoices = asyncHandler(async function checkPendingInvoices(req, res) {
    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);

    // Find all leads with active plans
    const leadsWithActivePlans = await prisma.lead.findMany({
      where: {
        actualPlanName: { not: null },
        actualPlanPrice: { not: null },
        actualPlanIsActive: true
      },
      select: {
        id: true,
        customerUsername: true,
        actualPlanName: true,
        actualPlanPrice: true,
        actualPlanBillingCycle: true,
        actualPlanStartDate: true,
        campaignData: { select: { company: true } },
        invoices: {
          where: { planName: { not: 'One Time Charge (OTC)' } },
          orderBy: { billingPeriodEnd: 'desc' },
          take: 1,
          select: {
            invoiceNumber: true,
            billingPeriodStart: true,
            billingPeriodEnd: true,
            status: true
          }
        }
      }
    });

    const needsInvoice = [];
    const upToDate = [];

    for (const lead of leadsWithActivePlans) {
      const lastInvoice = lead.invoices[0];
      if (!lastInvoice) {
        needsInvoice.push({
          leadId: lead.id,
          company: lead.campaignData?.company,
          customerUsername: lead.customerUsername,
          planName: lead.actualPlanName,
          planPrice: lead.actualPlanPrice,
          reason: 'No invoices generated yet'
        });
      } else {
        // Check if billing period has ended
        const periodEnd = new Date(lastInvoice.billingPeriodEnd);
        periodEnd.setUTCHours(0, 0, 0, 0);
        const nextPeriodStart = new Date(periodEnd);
        nextPeriodStart.setUTCDate(nextPeriodStart.getUTCDate() + 1);

        if (nextPeriodStart <= now) {
          needsInvoice.push({
            leadId: lead.id,
            company: lead.campaignData?.company,
            customerUsername: lead.customerUsername,
            planName: lead.actualPlanName,
            planPrice: lead.actualPlanPrice,
            lastInvoice: lastInvoice.invoiceNumber,
            lastPeriodEnd: lastInvoice.billingPeriodEnd,
            reason: 'Billing period ended, next invoice due'
          });
        } else {
          upToDate.push({
            leadId: lead.id,
            company: lead.campaignData?.company,
            lastInvoice: lastInvoice.invoiceNumber
          });
        }
      }
    }

    res.json({
      data: {
        needsInvoice,
        upToDate: upToDate.length,
        totalActiveLeads: leadsWithActivePlans.length,
        pendingCount: needsInvoice.length
      }
    });
});

// ---------------------------------------------------------------------------
// 20. PATCH /customer/:leadId/details  -  updateCustomerDetails
// ---------------------------------------------------------------------------
export const updateCustomerDetails = asyncHandler(async function updateCustomerDetails(req, res) {
    const { leadId } = req.params;

    if (!canAccessFinancials(req.user)) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const {
      customerUsername,
      companyName,
      contactPhone,
      contactEmail,
      billingAddress,
      billingPincode,
      installationAddress,
      installationPincode,
      customerGstNo,
      customerLegalName,
      panCardNo,
      tanNumber,
      poNumber,
      poExpiryDate,
      billDate,
      technicalInchargeMobile,
      technicalInchargeEmail,
      accountsInchargeMobile,
      accountsInchargeEmail,
      bdmName,
      serviceManager
    } = req.body;

    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true }
    });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    // Build update data (only set fields that were provided)
    const updateData = {};
    if (billingAddress !== undefined) updateData.billingAddress = billingAddress;
    if (billingPincode !== undefined) updateData.billingPincode = billingPincode;
    if (installationAddress !== undefined) updateData.installationAddress = installationAddress;
    if (installationPincode !== undefined) updateData.installationPincode = installationPincode;
    if (customerGstNo !== undefined) updateData.customerGstNo = customerGstNo;
    if (customerLegalName !== undefined) updateData.customerLegalName = customerLegalName;
    if (panCardNo !== undefined) updateData.panCardNo = panCardNo;
    if (tanNumber !== undefined) updateData.tanNumber = tanNumber;
    if (poNumber !== undefined) updateData.poNumber = poNumber;
    if (poExpiryDate !== undefined) updateData.poExpiryDate = poExpiryDate ? new Date(poExpiryDate) : null;
    if (billDate !== undefined) updateData.billDate = billDate ? new Date(billDate) : null;
    if (technicalInchargeMobile !== undefined) updateData.technicalInchargeMobile = technicalInchargeMobile;
    if (technicalInchargeEmail !== undefined) updateData.technicalInchargeEmail = technicalInchargeEmail;
    if (accountsInchargeMobile !== undefined) updateData.accountsInchargeMobile = accountsInchargeMobile;
    if (accountsInchargeEmail !== undefined) updateData.accountsInchargeEmail = accountsInchargeEmail;
    if (bdmName !== undefined) updateData.bdmName = bdmName;
    if (serviceManager !== undefined) updateData.serviceManager = serviceManager;

    // Update lead
    const updatedLead = await prisma.lead.update({
      where: { id: leadId },
      data: updateData,
      select: {
        id: true,
        customerUsername: true,
        billingAddress: true,
        billingPincode: true,
        installationAddress: true,
        installationPincode: true,
        customerGstNo: true,
        customerLegalName: true,
        panCardNo: true,
        tanNumber: true,
        poNumber: true,
        poExpiryDate: true,
        billDate: true,
        technicalInchargeMobile: true,
        technicalInchargeEmail: true,
        accountsInchargeMobile: true,
        accountsInchargeEmail: true,
        bdmName: true,
        serviceManager: true,
        campaignData: {
          select: { company: true, name: true, phone: true, email: true }
        }
      }
    });

    // If company name or contact details changed, also update on existing invoices
    if (companyName || contactPhone || contactEmail || customerUsername) {
      const invoiceUpdate = {};
      if (companyName) invoiceUpdate.companyName = companyName;
      if (contactPhone) invoiceUpdate.contactPhone = contactPhone;
      if (contactEmail) invoiceUpdate.contactEmail = contactEmail;
      if (customerUsername) invoiceUpdate.customerUsername = customerUsername;

      if (Object.keys(invoiceUpdate).length > 0) {
        await prisma.invoice.updateMany({
          where: { leadId },
          data: invoiceUpdate
        });
      }
    }

    // If company name was updated, update campaign data too
    if (companyName) {
      const leadFull = await prisma.lead.findUnique({
        where: { id: leadId },
        select: { campaignDataId: true }
      });
      if (leadFull?.campaignDataId) {
        await prisma.campaignData.update({
          where: { id: leadFull.campaignDataId },
          data: { company: companyName }
        });
      }
    }

    res.json({
      message: 'Customer details updated successfully.',
      data: updatedLead
    });
});

// ---------------------------------------------------------------------------
// 21. POST /migrate/credit-note-advances  -  migrateAdvancePaymentsFromCreditNotes
// ---------------------------------------------------------------------------
export const migrateAdvancePaymentsFromCreditNotes = asyncHandler(async function migrateAdvancePaymentsFromCreditNotes(req, res) {
    if (!isAdminOrTestUser(req.user)) {
      return res.status(403).json({ message: 'Only super admins can run migrations.' });
    }

    // Find credit-note-sourced advance payments missing ledger entries
    const advancePayments = await prisma.advancePayment.findMany({
      where: {
        paymentMode: 'CREDIT_NOTE'
      },
      include: {
        lead: {
          select: { id: true, customerUsername: true }
        }
      }
    });

    let created = 0;
    let skipped = 0;

    for (const ap of advancePayments) {
      // Check if ledger entry already exists for this advance
      const existingEntry = await prisma.ledgerEntry.findFirst({
        where: {
          referenceId: ap.receiptNumber,
          referenceType: 'ADVANCE_PAYMENT'
        }
      });

      if (existingEntry) {
        skipped++;
        continue;
      }

      try {
        const previousBalance = await getCustomerBalance(ap.leadId);
        const runningBalance = previousBalance - ap.amount;

        await prisma.ledgerEntry.create({
          data: {
            customerId: ap.leadId,
            entryDate: ap.createdAt,
            entryType: 'PAYMENT',
            referenceType: 'ADVANCE_PAYMENT',
            referenceId: ap.receiptNumber,
            referenceNumber: ap.receiptNumber,
            debitAmount: 0,
            creditAmount: ap.amount,
            runningBalance,
            description: `Advance payment from Credit Note - ${ap.receiptNumber}`,
            createdById: ap.createdById
          }
        });
        created++;
      } catch (err) {
        console.error(`Failed to create ledger entry for advance ${ap.receiptNumber}:`, err);
      }
    }

    res.json({
      message: `Migration complete. Created ${created} ledger entries, skipped ${skipped}.`,
      data: { created, skipped, total: advancePayments.length }
    });
});

// ---------------------------------------------------------------------------
// 22. DELETE /cleanup/all-billing-data  -  cleanupAllBillingData (ADMIN ONLY)
// ---------------------------------------------------------------------------
export const cleanupAllBillingData = asyncHandler(async function cleanupAllBillingData(req, res) {
    if (!isAdminOrTestUser(req.user)) {
      return res.status(403).json({ message: 'Only super admins can perform cleanup.' });
    }

    const { confirm } = req.body;

    if (confirm !== 'DELETE_ALL_BILLING_DATA') {
      return res.status(400).json({
        message: 'Confirmation required. Send { confirm: "DELETE_ALL_BILLING_DATA" } to proceed.'
      });
    }

    // Delete in dependency order
    const results = await prisma.$transaction(async (tx) => {
      const ledger = await tx.ledgerEntry.deleteMany({});
      const payments = await tx.invoicePayment.deleteMany({});
      const creditNotes = await tx.creditNote.deleteMany({});
      const advances = await tx.advancePayment.deleteMany({});
      const invoices = await tx.invoice.deleteMany({});

      // Clear OTC invoice references on leads
      await tx.lead.updateMany({
        where: { otcInvoiceId: { not: null } },
        data: { otcInvoiceId: null, otcInvoiceGeneratedAt: null }
      });

      // Reset document sequences
      await tx.documentSequence.updateMany({
        where: { documentType: { in: ['INVOICE', 'RECEIPT', 'CREDIT_NOTE', 'OTC_INVOICE', 'ADVANCE_PAYMENT'] } },
        data: { lastNumber: 0 }
      });

      return {
        ledgerEntries: ledger.count,
        payments: payments.count,
        creditNotes: creditNotes.count,
        advancePayments: advances.count,
        invoices: invoices.count
      };
    });

    emitSidebarRefreshByRole('ACCOUNTS_TEAM');
    emitSidebarRefreshByRole('SUPER_ADMIN');

    res.json({
      message: 'All billing data cleaned up successfully.',
      data: results
    });
});
