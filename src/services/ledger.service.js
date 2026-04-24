/**
 * Ledger Service - Single Source of Truth for Customer Financial Transactions
 *
 * CRITICAL RULES:
 * 1. Ledger is APPEND-ONLY - No updates, no deletes
 * 2. One ledger per customer (leadId)
 * 3. Running balance = totalDebit - totalCredit
 * 4. Debit = Customer owes more | Credit = Customer owes less
 *
 * Entry Types:
 * - INVOICE: Debit (customer owes)
 * - PAYMENT: Credit (customer paid)
 * - CREDIT_NOTE: Credit (we reduce their bill)
 * - REFUND: Debit (we returned money, reversing credit)
 *
 * CONCURRENCY: All balance-mutating operations use Serializable transactions
 * to prevent race conditions. If two operations target the same customer
 * concurrently, one will retry automatically (up to 3 attempts).
 */

import prisma from '../config/db.js';

const MAX_RETRIES = 3;

/**
 * Retry wrapper for Serializable transaction conflicts.
 * PostgreSQL throws serialization failures (Prisma P2034) when two
 * concurrent Serializable transactions conflict. This retries safely.
 */
async function withSerializableRetry(fn) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(fn, { isolationLevel: 'Serializable' });
    } catch (error) {
      const isSerializationFailure =
        error.code === 'P2034' ||
        error.message?.includes('could not serialize') ||
        error.message?.includes('deadlock');

      if (isSerializationFailure && attempt < MAX_RETRIES) {
        console.warn(`[Ledger] Serialization conflict, retrying (attempt ${attempt + 1}/${MAX_RETRIES})...`);
        // Small random backoff to reduce repeated collisions
        await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
        continue;
      }
      throw error;
    }
  }
}

/**
 * Get the current running balance for a customer (standalone, no transaction)
 * @param {string} customerId - Lead ID
 * @returns {number} Current balance (positive = customer owes, negative = we owe)
 */
export const getCustomerBalance = async (customerId) => {
  const lastEntry = await prisma.ledgerEntry.findFirst({
    where: { customerId },
    orderBy: [
      { entryDate: 'desc' },
      { createdAt: 'desc' }
    ],
    select: { runningBalance: true }
  });

  return Number(lastEntry?.runningBalance) || 0;
};

/**
 * Get the current running balance inside a transaction
 */
const getCustomerBalanceTx = async (tx, customerId) => {
  const lastEntry = await tx.ledgerEntry.findFirst({
    where: { customerId },
    orderBy: [
      { entryDate: 'desc' },
      { createdAt: 'desc' }
    ],
    select: { runningBalance: true }
  });

  return Number(lastEntry?.runningBalance) || 0;
};

/**
 * Calculate running balance from previous balance + debit - credit
 */
const calculateRunningBalance = (previousBalance, debitAmount, creditAmount) => {
  return previousBalance + debitAmount - creditAmount;
};

/**
 * Create a ledger entry for an invoice
 * Called when an invoice is GENERATED
 */
export const createInvoiceLedgerEntry = async (invoice, userId = null) => {
  const entry = await withSerializableRetry(async (tx) => {
    const previousBalance = await getCustomerBalanceTx(tx, invoice.leadId);

    const debitAmount = Number(invoice.grandTotal);
    const creditAmount = 0;
    const runningBalance = calculateRunningBalance(previousBalance, debitAmount, creditAmount);

    // Format billing period for description
    const periodStart = new Date(invoice.billingPeriodStart).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric'
    });
    const periodEnd = new Date(invoice.billingPeriodEnd).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric'
    });

    return tx.ledgerEntry.create({
      data: {
        customerId: invoice.leadId,
        entryDate: invoice.invoiceDate,
        entryType: 'INVOICE',
        referenceType: 'INVOICE',
        referenceId: invoice.id,
        referenceNumber: invoice.invoiceNumber,
        debitAmount,
        creditAmount,
        runningBalance,
        description: `Invoice ${invoice.invoiceNumber} for billing period ${periodStart} to ${periodEnd}`,
        createdById: userId
      }
    });
  });

  console.log(`[Ledger] Invoice entry created: ${invoice.invoiceNumber}, Debit: ₹${entry.debitAmount}, Balance: ₹${entry.runningBalance}`);
  return entry;
};

/**
 * Create a ledger entry for a payment
 * Called when a payment is recorded
 */
export const createPaymentLedgerEntry = async (payment, invoice, customerId, userId = null) => {
  const entry = await withSerializableRetry(async (tx) => {
    const previousBalance = await getCustomerBalanceTx(tx, customerId);

    const debitAmount = 0;
    const creditAmount = (Number(payment.amount) || 0) + (Number(payment.tdsAmount) || 0);
    const runningBalance = calculateRunningBalance(previousBalance, debitAmount, creditAmount);

    // Build description with payment mode
    const paymentModeMap = {
      'CHEQUE': 'Cheque',
      'NEFT': 'NEFT',
      'ONLINE': 'Online Payment',
      'TDS': 'TDS Deduction'
    };
    const modeLabel = paymentModeMap[payment.paymentMode] || payment.paymentMode;

    let description = `Payment received via ${modeLabel}`;
    if (payment.tdsAmount > 0) {
      description += ` (Amount: ₹${payment.amount}, TDS: ₹${payment.tdsAmount})`;
    }
    description += ` against ${invoice.invoiceNumber}`;

    return tx.ledgerEntry.create({
      data: {
        customerId,
        entryDate: payment.paymentDate || new Date(),
        entryType: 'PAYMENT',
        referenceType: 'PAYMENT',
        referenceId: payment.id,
        referenceNumber: payment.receiptNumber,
        debitAmount,
        creditAmount,
        runningBalance,
        description,
        createdById: userId
      }
    });
  });

  console.log(`[Ledger] Payment entry created: ${payment.receiptNumber}, Credit: ₹${entry.creditAmount}, Balance: ₹${entry.runningBalance}`);
  return entry;
};

/**
 * Create a ledger entry for a credit note
 * Called when a credit note is ISSUED
 */
export const createCreditNoteLedgerEntry = async (creditNote, invoice, customerId, userId = null) => {
  const entry = await withSerializableRetry(async (tx) => {
    const previousBalance = await getCustomerBalanceTx(tx, customerId);

    const debitAmount = 0;
    const creditAmount = Number(creditNote.totalAmount);
    const runningBalance = calculateRunningBalance(previousBalance, debitAmount, creditAmount);

    // Build description with reason
    const reasonMap = {
      'SERVICE_DOWNTIME': 'Service Downtime',
      'OVERPAYMENT': 'Overpayment',
      'PRICE_ADJUSTMENT': 'Price Adjustment',
      'CANCELLATION': 'Cancellation',
      'ERROR_CORRECTION': 'Error Correction',
      'PLAN_DOWNGRADE': 'Plan Downgrade'
    };
    const reasonLabel = reasonMap[creditNote.reason] || creditNote.reason;

    return tx.ledgerEntry.create({
      data: {
        customerId,
        entryDate: creditNote.creditNoteDate || new Date(),
        entryType: 'CREDIT_NOTE',
        referenceType: 'CREDIT_NOTE',
        referenceId: creditNote.id,
        referenceNumber: creditNote.creditNoteNumber,
        debitAmount,
        creditAmount,
        runningBalance,
        description: `Credit Note ${creditNote.creditNoteNumber} issued - ${reasonLabel} against ${invoice.invoiceNumber}`,
        createdById: userId
      }
    });
  });

  console.log(`[Ledger] Credit Note entry created: ${creditNote.creditNoteNumber}, Credit: ₹${entry.creditAmount}, Balance: ₹${entry.runningBalance}`);
  return entry;
};

/**
 * Create a ledger entry for a refund
 * Called when a refund is processed
 */
export const createRefundLedgerEntry = async (refund, customerId, userId = null) => {
  const entry = await withSerializableRetry(async (tx) => {
    const previousBalance = await getCustomerBalanceTx(tx, customerId);

    const debitAmount = Number(refund.amount);
    const creditAmount = 0;
    const runningBalance = calculateRunningBalance(previousBalance, debitAmount, creditAmount);

    return tx.ledgerEntry.create({
      data: {
        customerId,
        entryDate: refund.refundDate || new Date(),
        entryType: 'REFUND',
        referenceType: 'CREDIT_NOTE',
        referenceId: refund.creditNoteId,
        referenceNumber: refund.refundReference || `REF-${Date.now()}`,
        debitAmount,
        creditAmount,
        runningBalance,
        description: `Refund processed via ${refund.refundMode || 'Bank Transfer'} for Credit Note ${refund.creditNoteNumber}`,
        createdById: userId
      }
    });
  });

  console.log(`[Ledger] Refund entry created: ${refund.refundReference}, Debit: ₹${entry.debitAmount}, Balance: ₹${entry.runningBalance}`);
  return entry;
};

/**
 * Get customer ledger with all entries
 * Sorted chronologically (oldest to newest)
 */
export const getCustomerLedger = async (customerId, options = {}) => {
  const { startDate, endDate, limit, offset } = options;

  // Build where clause
  const where = { customerId };
  if (startDate || endDate) {
    where.entryDate = {};
    if (startDate) where.entryDate.gte = new Date(startDate);
    if (endDate) where.entryDate.lte = new Date(endDate);
  }

  // Get customer info
  const customer = await prisma.lead.findUnique({
    where: { id: customerId },
    include: {
      campaignData: {
        select: { company: true, name: true, phone: true, email: true, address: true, city: true, state: true }
      }
    }
  });

  if (!customer) {
    throw new Error('Customer not found');
  }

  // Get ledger entries (chronological order - oldest first)
  const entries = await prisma.ledgerEntry.findMany({
    where,
    orderBy: [
      { entryDate: 'asc' },
      { createdAt: 'asc' }
    ],
    skip: offset || 0,
    take: limit || undefined,
    include: {
      createdBy: {
        select: { id: true, name: true }
      }
    }
  });

  // Get total count for pagination
  const totalEntries = await prisma.ledgerEntry.count({ where });

  // Calculate summary totals
  const summary = await prisma.ledgerEntry.aggregate({
    where: { customerId },
    _sum: {
      debitAmount: true,
      creditAmount: true
    }
  });

  const totalDebit = Number(summary._sum.debitAmount) || 0;
  const totalCredit = Number(summary._sum.creditAmount) || 0;
  const currentBalance = totalDebit - totalCredit;

  // Get entry counts by type
  const entryCounts = await prisma.ledgerEntry.groupBy({
    by: ['entryType'],
    where: { customerId },
    _count: { id: true },
    _sum: { debitAmount: true, creditAmount: true }
  });

  const typeBreakdown = {
    invoices: { count: 0, total: 0 },
    payments: { count: 0, total: 0 },
    creditNotes: { count: 0, total: 0 },
    refunds: { count: 0, total: 0 }
  };

  entryCounts.forEach(item => {
    switch (item.entryType) {
      case 'INVOICE':
        typeBreakdown.invoices = { count: item._count.id, total: Number(item._sum.debitAmount) || 0 };
        break;
      case 'PAYMENT':
        typeBreakdown.payments = { count: item._count.id, total: Number(item._sum.creditAmount) || 0 };
        break;
      case 'CREDIT_NOTE':
        typeBreakdown.creditNotes = { count: item._count.id, total: Number(item._sum.creditAmount) || 0 };
        break;
      case 'REFUND':
        typeBreakdown.refunds = { count: item._count.id, total: Number(item._sum.debitAmount) || 0 };
        break;
    }
  });

  return {
    customer: {
      id: customer.id,
      companyName: customer.campaignData?.company || 'Unknown',
      customerUsername: customer.customerUsername,
      contactName: customer.campaignData?.name,
      phone: customer.campaignData?.phone,
      email: customer.campaignData?.email,
      address: customer.campaignData?.address,
      city: customer.campaignData?.city,
      state: customer.campaignData?.state
    },
    summary: {
      totalDebit,
      totalCredit,
      currentBalance,
      balanceStatus: currentBalance > 0 ? 'RECEIVABLE' : currentBalance < 0 ? 'PAYABLE' : 'SETTLED',
      ...typeBreakdown
    },
    entries,
    pagination: {
      total: totalEntries,
      offset: offset || 0,
      limit: limit || totalEntries
    }
  };
};

/**
 * Verify ledger reconciliation with source tables
 * This ensures data integrity
 */
export const verifyLedgerReconciliation = async (customerId = null) => {
  const where = customerId ? { customerId } : {};
  const customerWhere = customerId ? { leadId: customerId } : {};

  // Get ledger totals
  const ledgerTotals = await prisma.ledgerEntry.groupBy({
    by: ['entryType'],
    where,
    _sum: { debitAmount: true, creditAmount: true }
  });

  let ledgerInvoiceTotal = 0;
  let ledgerPaymentTotal = 0;
  let ledgerCreditNoteTotal = 0;

  ledgerTotals.forEach(item => {
    if (item.entryType === 'INVOICE') ledgerInvoiceTotal = Number(item._sum.debitAmount) || 0;
    if (item.entryType === 'PAYMENT') ledgerPaymentTotal = Number(item._sum.creditAmount) || 0;
    if (item.entryType === 'CREDIT_NOTE') ledgerCreditNoteTotal = Number(item._sum.creditAmount) || 0;
  });

  // Get source table totals
  const invoiceTotal = await prisma.invoice.aggregate({
    where: customerWhere,
    _sum: { grandTotal: true }
  });

  const paymentTotal = await prisma.invoicePayment.aggregate({
    where: customerId ? { invoice: { leadId: customerId } } : {},
    _sum: { amount: true, tdsAmount: true }
  });

  const creditNoteTotal = await prisma.creditNote.aggregate({
    where: customerId ? { invoice: { leadId: customerId } } : {},
    _sum: { totalAmount: true }
  });

  const sourceInvoiceTotal = Number(invoiceTotal._sum.grandTotal) || 0;
  const sourcePaymentTotal = (Number(paymentTotal._sum.amount) || 0) + (Number(paymentTotal._sum.tdsAmount) || 0);
  const sourceCreditNoteTotal = Number(creditNoteTotal._sum.totalAmount) || 0;

  // Check reconciliation
  const invoiceMatch = Math.abs(ledgerInvoiceTotal - sourceInvoiceTotal) < 1;
  const paymentMatch = Math.abs(ledgerPaymentTotal - sourcePaymentTotal) < 1;
  const creditNoteMatch = Math.abs(ledgerCreditNoteTotal - sourceCreditNoteTotal) < 1;

  return {
    reconciled: invoiceMatch && paymentMatch && creditNoteMatch,
    invoices: {
      ledger: ledgerInvoiceTotal,
      source: sourceInvoiceTotal,
      match: invoiceMatch,
      difference: ledgerInvoiceTotal - sourceInvoiceTotal
    },
    payments: {
      ledger: ledgerPaymentTotal,
      source: sourcePaymentTotal,
      match: paymentMatch,
      difference: ledgerPaymentTotal - sourcePaymentTotal
    },
    creditNotes: {
      ledger: ledgerCreditNoteTotal,
      source: sourceCreditNoteTotal,
      match: creditNoteMatch,
      difference: ledgerCreditNoteTotal - sourceCreditNoteTotal
    }
  };
};

/**
 * Backfill ledger entries for existing data
 * Use this ONCE during migration
 */
export const backfillLedgerEntries = async (customerId = null) => {
  console.log('[Ledger Backfill] Starting backfill process...');

  const customerWhere = customerId ? { id: customerId } : { actualPlanName: { not: null } };

  const customers = await prisma.lead.findMany({
    where: customerWhere,
    include: {
      invoices: {
        orderBy: { invoiceDate: 'asc' },
        include: {
          payments: { orderBy: { paymentDate: 'asc' } },
          creditNotes: { orderBy: { createdAt: 'asc' } }
        }
      }
    }
  });

  let totalEntries = 0;

  for (const customer of customers) {
    // Check if customer already has ledger entries
    const existingEntries = await prisma.ledgerEntry.count({
      where: { customerId: customer.id }
    });

    if (existingEntries > 0) {
      console.log(`[Ledger Backfill] Skipping ${customer.campaignData?.company || customer.id} - already has ${existingEntries} entries`);
      continue;
    }

    console.log(`[Ledger Backfill] Processing ${customer.campaignData?.company || customer.id}...`);

    // Collect all events and sort chronologically
    const events = [];

    for (const invoice of customer.invoices) {
      events.push({
        type: 'INVOICE',
        date: invoice.invoiceDate,
        data: invoice
      });

      for (const payment of invoice.payments) {
        events.push({
          type: 'PAYMENT',
          date: payment.paymentDate,
          data: { payment, invoice }
        });
      }

      for (const creditNote of invoice.creditNotes) {
        events.push({
          type: 'CREDIT_NOTE',
          date: creditNote.creditNoteDate || creditNote.createdAt,
          data: { creditNote, invoice }
        });
      }
    }

    // Sort events chronologically
    events.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Create ledger entries in order
    for (const event of events) {
      try {
        switch (event.type) {
          case 'INVOICE':
            await createInvoiceLedgerEntry(event.data, event.data.createdById);
            break;
          case 'PAYMENT':
            await createPaymentLedgerEntry(
              event.data.payment,
              event.data.invoice,
              customer.id,
              event.data.payment.createdById
            );
            break;
          case 'CREDIT_NOTE':
            await createCreditNoteLedgerEntry(
              event.data.creditNote,
              event.data.invoice,
              customer.id,
              event.data.creditNote.createdById
            );
            break;
        }
        totalEntries++;
      } catch (error) {
        console.error(`[Ledger Backfill] Error processing event:`, error);
      }
    }
  }

  console.log(`[Ledger Backfill] Completed. Created ${totalEntries} ledger entries.`);

  return { totalEntries, customersProcessed: customers.length };
};

/**
 * Delete ledger entries for a specific invoice and recalculate running balances.
 * Used when voiding/deleting an invoice (e.g., during plan upgrade).
 *
 * Two calling modes:
 *   - Standalone: `deleteLedgerEntriesForInvoice(invoiceId, customerId)` runs in
 *     its own Serializable transaction with retry on serialization conflicts.
 *   - Inside an outer transaction: pass the tx client as the third arg to make
 *     the ledger cleanup atomic with the caller's other writes (e.g. deleting
 *     the invoice row). The caller is responsible for choosing the isolation
 *     level of the outer transaction.
 */
const deleteLedgerEntriesForInvoiceTx = async (tx, invoiceId, customerId) => {
  const deleted = await tx.ledgerEntry.deleteMany({
    where: {
      referenceId: invoiceId,
      referenceType: 'INVOICE'
    }
  });

  if (customerId && deleted.count > 0) {
    const entries = await tx.ledgerEntry.findMany({
      where: { customerId },
      orderBy: [
        { entryDate: 'asc' },
        { createdAt: 'asc' },
        { id: 'asc' }
      ]
    });

    let runningBalance = 0;
    for (const entry of entries) {
      runningBalance = runningBalance + (Number(entry.debitAmount) || 0) - (Number(entry.creditAmount) || 0);
      await tx.ledgerEntry.update({
        where: { id: entry.id },
        data: { runningBalance }
      });
    }
  }

  return deleted.count;
};

export const deleteLedgerEntriesForInvoice = async (invoiceId, customerId, tx = null) => {
  try {
    const deletedCount = tx
      ? await deleteLedgerEntriesForInvoiceTx(tx, invoiceId, customerId)
      : await withSerializableRetry((innerTx) => deleteLedgerEntriesForInvoiceTx(innerTx, invoiceId, customerId));

    console.log(`[Ledger] Deleted ${deletedCount} ledger entries for invoice ${invoiceId}`);
    if (customerId && deletedCount > 0) {
      console.log(`[Ledger] Recalculated running balances for customer ${customerId}`);
    }

    return deletedCount;
  } catch (error) {
    console.error('[Ledger] Error deleting ledger entries:', error);
    throw error;
  }
};

export default {
  getCustomerBalance,
  createInvoiceLedgerEntry,
  createPaymentLedgerEntry,
  createCreditNoteLedgerEntry,
  createRefundLedgerEntry,
  getCustomerLedger,
  verifyLedgerReconciliation,
  backfillLedgerEntries,
  deleteLedgerEntriesForInvoice
};
