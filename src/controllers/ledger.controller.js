/**
 * Ledger Controller
 * Handles API endpoints for customer ledger operations
 */

import {
  getCustomerLedger,
  getCustomerBalance,
  verifyLedgerReconciliation,
  backfillLedgerEntries
} from '../services/ledger.service.js';
import { isAdminOrTestUser } from '../utils/roleHelper.js';
import { asyncHandler } from '../utils/controllerHelper.js';

/**
 * Get customer ledger with all entries
 * GET /api/ledger/customer/:customerId
 */
export const getLedger = asyncHandler(async function getLedger(req, res) {
  const { customerId } = req.params;
  const { startDate, endDate, limit, offset } = req.query;

  try {
    const ledger = await getCustomerLedger(customerId, {
      startDate,
      endDate,
      limit: limit ? parseInt(limit) : undefined,
      offset: offset ? parseInt(offset) : undefined
    });

    res.json(ledger);
  } catch (error) {
    if (error.message === 'Customer not found') {
      return res.status(404).json({ message: 'Customer not found.' });
    }
    throw error;
  }
});

/**
 * Get customer current balance
 * GET /api/ledger/customer/:customerId/balance
 */
export const getBalance = asyncHandler(async function getBalance(req, res) {
  const { customerId } = req.params;

  const balance = await getCustomerBalance(customerId);

  res.json({
    customerId,
    balance,
    status: balance > 0 ? 'RECEIVABLE' : balance < 0 ? 'PAYABLE' : 'SETTLED',
    message: balance > 0
      ? `Customer owes ₹${balance.toFixed(2)}`
      : balance < 0
        ? `We owe customer ₹${Math.abs(balance).toFixed(2)}`
        : 'Account is settled'
  });
});

/**
 * Verify ledger reconciliation
 * GET /api/ledger/reconciliation
 * GET /api/ledger/reconciliation/:customerId
 */
export const checkReconciliation = asyncHandler(async function checkReconciliation(req, res) {
  const { customerId } = req.params;

  const report = await verifyLedgerReconciliation(customerId || null);

  if (!report.reconciled) {
    return res.status(200).json({
      message: 'Reconciliation FAILED - Ledger does not match source data',
      ...report
    });
  }

  res.json({
    message: 'Reconciliation PASSED - Ledger matches source data',
    ...report
  });
});

/**
 * Backfill ledger entries from existing data
 * POST /api/ledger/backfill
 * ADMIN ONLY - Use once during migration
 */
export const runBackfill = asyncHandler(async function runBackfill(req, res) {
  const { customerId } = req.body;

  // Only allow super admin or test user
  if (!isAdminOrTestUser(req.user)) {
    return res.status(403).json({ message: 'Only super admin can run backfill.' });
  }

  const result = await backfillLedgerEntries(customerId || null);

  res.json({
    message: 'Backfill completed successfully',
    ...result
  });
});

/**
 * Get ledger statement for download/print
 * GET /api/ledger/customer/:customerId/statement
 */
export const getLedgerStatement = asyncHandler(async function getLedgerStatement(req, res) {
  const { customerId } = req.params;
  const { startDate, endDate, format } = req.query;

  try {
    const ledger = await getCustomerLedger(customerId, { startDate, endDate });

    // Format for statement (could be used for PDF generation)
    const statement = {
      generatedAt: new Date().toISOString(),
      period: {
        from: startDate || 'Beginning',
        to: endDate || 'Current'
      },
      customer: ledger.customer,
      openingBalance: ledger.entries.length > 0
        ? (ledger.entries[0].runningBalance - ledger.entries[0].debitAmount + ledger.entries[0].creditAmount)
        : 0,
      closingBalance: ledger.summary.currentBalance,
      entries: ledger.entries.map(entry => ({
        date: entry.entryDate,
        particulars: entry.description,
        referenceNumber: entry.referenceNumber,
        debit: entry.debitAmount || null,
        credit: entry.creditAmount || null,
        balance: entry.runningBalance
      })),
      totals: {
        totalDebit: ledger.summary.totalDebit,
        totalCredit: ledger.summary.totalCredit
      }
    };

    res.json(statement);
  } catch (error) {
    if (error.message === 'Customer not found') {
      return res.status(404).json({ message: 'Customer not found.' });
    }
    throw error;
  }
});
