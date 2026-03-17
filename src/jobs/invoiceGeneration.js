import cron from 'node-cron';
import prisma from '../config/db.js';
import { createInvoiceLedgerEntry } from '../services/ledger.service.js';
import { generateInvoiceNumber } from '../services/documentNumber.service.js';
import { emitSidebarRefreshByRole } from '../sockets/index.js';

/**
 * Normalize date to start of day in UTC (remove time component)
 * IMPORTANT: Use UTC methods to avoid timezone issues since DB stores dates in UTC
 */
const normalizeDate = (date) => {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

/**
 * Add months to a date, handling month-end edge cases properly
 * If the target month doesn't have the same day, use the last day of that month
 */
const addMonthsUTC = (date, months) => {
  const result = new Date(date);
  const originalDay = result.getUTCDate();

  // Move to the first of the month, then add months
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);

  // Get the last day of the target month
  const lastDayOfMonth = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();

  // Use the original day or last day of month, whichever is smaller
  result.setUTCDate(Math.min(originalDay, lastDayOfMonth));

  return result;
};

/**
 * Calculate billing period end based on start date and billing cycle
 * Supports: MONTHLY, QUARTERLY, HALF_YEARLY, YEARLY
 *
 * The billing period is inclusive: Jan 30 QUARTERLY → ends Apr 30
 * Next billing period starts May 1
 */
const calculateBillingPeriodEnd = (startDate, billingCycle, validityDays, billingType) => {
  const start = normalizeDate(startDate);
  let end;

  // Use billing cycle if available, otherwise fall back to billing type
  if (billingCycle) {
    let monthsToAdd;
    switch (billingCycle) {
      case 'MONTHLY':
        monthsToAdd = 1;
        break;
      case 'QUARTERLY':
        monthsToAdd = 3;
        break;
      case 'HALF_YEARLY':
        monthsToAdd = 6;
        break;
      case 'YEARLY':
        monthsToAdd = 12;
        break;
      default:
        monthsToAdd = 1;
    }
    // End date is the same day of the month, X months later
    // Example: Jan 30 + 3 months = Apr 30 (QUARTERLY)
    end = addMonthsUTC(start, monthsToAdd);
  } else if (billingType === 'MONTHLY') {
    // Legacy: For MONTHLY billing type, end at the last day of the month
    end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  } else {
    // Legacy: For DAY_TO_DAY billing, add validity days
    // Subtract 1 because period is inclusive: Day 1 = start, Day N = start + (N-1)
    // e.g., 90-day plan starting Jan 31: end = Jan 31 + 89 = Apr 30
    end = new Date(start);
    end.setUTCDate(end.getUTCDate() + (validityDays || 30) - 1);
  }

  return normalizeDate(end);
};

/**
 * Check if an invoice already exists for a given lead and billing period
 * Excludes OTC invoices from the check
 */
const invoiceExistsForPeriod = async (leadId, periodStart, periodEnd) => {
  const startNorm = normalizeDate(periodStart);

  // Check with a date range to handle potential timezone issues
  const startMin = new Date(startNorm);
  startMin.setUTCHours(0, 0, 0, 0);
  const startMax = new Date(startNorm);
  startMax.setUTCHours(23, 59, 59, 999);

  const existing = await prisma.invoice.findFirst({
    where: {
      leadId,
      // Exclude OTC invoices
      planName: { not: 'One Time Charge (OTC)' },
      billingPeriodStart: {
        gte: startMin,
        lte: startMax
      }
    }
  });

  return !!existing;
};

/**
 * Generate a single invoice for a lead
 */
const createInvoice = async (lead, billingPeriodStart, billingPeriodEnd, systemUserId) => {
  const baseAmount = lead.actualPlanPrice;
  const discountAmount = 0;
  const taxableAmount = baseAmount - discountAmount;
  const sgstRate = 9;
  const cgstRate = 9;
  const sgstAmount = (taxableAmount * sgstRate) / 100;
  const cgstAmount = (taxableAmount * cgstRate) / 100;
  const totalGstAmount = sgstAmount + cgstAmount;
  const grandTotal = taxableAmount + totalGstAmount;

  const invoiceNumber = await generateInvoiceNumber();

  // Due date is 15 days from invoice creation
  const invoiceDate = new Date();
  const dueDate = new Date(invoiceDate);
  dueDate.setUTCDate(dueDate.getUTCDate() + 15);

  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber,
      leadId: lead.id,
      invoiceDate,
      dueDate,
      billingPeriodStart: normalizeDate(billingPeriodStart),
      billingPeriodEnd: normalizeDate(billingPeriodEnd),
      companyName: lead.campaignData?.company || 'Unknown',
      customerUsername: lead.customerUsername,
      billingAddress: lead.billingAddress || lead.fullAddress || lead.campaignData?.address,
      installationAddress: lead.fullAddress,
      contactPhone: lead.campaignData?.phone,
      contactEmail: lead.campaignData?.email,
      planName: `${lead.customerUsername || 'Customer'}_${lead.actualPlanName}`,
      planDescription: 'Internet Leased Line',
      hsnSacCode: '998422',
      baseAmount,
      discountAmount,
      taxableAmount,
      sgstRate,
      cgstRate,
      sgstAmount,
      cgstAmount,
      totalGstAmount,
      grandTotal,
      status: 'GENERATED',
      notes: 'Auto-generated invoice at billing cycle start (advance billing)',
      createdById: systemUserId
    }
  });

  // Create ledger entry for the invoice
  try {
    await createInvoiceLedgerEntry(invoice, systemUserId);
  } catch (ledgerError) {
    console.error('[Invoice Job] Failed to create ledger entry:', ledgerError);
    // Don't fail the invoice creation if ledger entry fails
  }

  return invoice;
};

/**
 * Check for leads with active plans that need invoicing
 * and auto-generate invoices when billing cycle STARTS (advance billing)
 *
 * IMPORTANT: This function generates ALL missed invoices if multiple
 * billing cycles have passed since the last invoice.
 */
const generatePendingInvoices = async () => {
  try {
    const now = normalizeDate(new Date());
    console.log(`[Invoice Job] Running invoice generation check at ${new Date().toISOString()}`);

    // Find all leads with active actual plans
    const leadsWithActivePlans = await prisma.lead.findMany({
      where: {
        actualPlanName: { not: null },
        actualPlanPrice: { not: null },
        actualPlanIsActive: true
      },
      include: {
        campaignData: {
          select: { company: true, name: true, phone: true, email: true, city: true, state: true, address: true }
        },
        invoices: {
          where: {
            // Exclude OTC invoices when finding the last billing invoice
            planName: { not: 'One Time Charge (OTC)' }
          },
          orderBy: { billingPeriodEnd: 'desc' },
          take: 1
        }
      }
    });

    console.log(`[Invoice Job] Found ${leadsWithActivePlans.length} leads with active plans`);

    if (leadsWithActivePlans.length === 0) {
      console.log('[Invoice Job] No active plans found. Exiting.');
      return;
    }

    // Get system user for attribution
    let systemUser = await prisma.user.findFirst({
      where: { role: 'ACCOUNTS_TEAM', isActive: true },
      select: { id: true }
    });

    if (!systemUser) {
      systemUser = await prisma.user.findFirst({
        where: { role: 'SUPER_ADMIN', isActive: true },
        select: { id: true }
      });
    }

    if (!systemUser) {
      console.error('[Invoice Job] No system user found for invoice generation');
      return;
    }

    let totalInvoicesGenerated = 0;

    for (const lead of leadsWithActivePlans) {
      try {
        const validityDays = lead.actualPlanValidityDays || 30;
        const billingType = lead.actualPlanBillingType || 'DAY_TO_DAY';
        const billingCycle = lead.actualPlanBillingCycle || 'MONTHLY'; // Use new billing cycle field
        const lastInvoice = lead.invoices[0];

        console.log(`\n[Invoice Job] Processing: ${lead.campaignData?.company || lead.id}`);
        console.log(`  Plan: ${lead.actualPlanName}, Price: ₹${lead.actualPlanPrice}, Billing Cycle: ${billingCycle}`);

        // Determine the start date for billing calculations
        let billingStartDate;
        if (lastInvoice) {
          // Start from the day after last billing period ended
          billingStartDate = new Date(lastInvoice.billingPeriodEnd);
          billingStartDate.setUTCDate(billingStartDate.getUTCDate() + 1); // Use UTC
          console.log(`  Last Invoice: ${lastInvoice.invoiceNumber}, Period ended: ${lastInvoice.billingPeriodEnd.toISOString().split('T')[0]}`);
        } else {
          // First invoice - use plan start date
          billingStartDate = lead.actualPlanStartDate
            ? new Date(lead.actualPlanStartDate)
            : lead.actualPlanCreatedAt
              ? new Date(lead.actualPlanCreatedAt)
              : new Date();
          console.log(`  No previous invoices. Starting from plan start: ${billingStartDate.toISOString().split('T')[0]}`);
        }

        billingStartDate = normalizeDate(billingStartDate);

        // Generate invoices for all completed billing periods
        let invoicesForThisLead = 0;
        let maxIterations = 24; // Safety limit: max 24 billing cycles (2 years of monthly)

        while (maxIterations > 0) {
          maxIterations--;

          const billingPeriodStart = new Date(billingStartDate);
          const billingPeriodEnd = calculateBillingPeriodEnd(billingPeriodStart, billingCycle, validityDays, billingType);

          // Check if this billing period has STARTED (advance billing - invoice at start of period)
          if (billingPeriodStart > now) {
            console.log(`  Next period: ${billingPeriodStart.toISOString().split('T')[0]} to ${billingPeriodEnd.toISOString().split('T')[0]} (Not yet started)`);
            break;
          }

          // Check if invoice already exists for this period
          const exists = await invoiceExistsForPeriod(lead.id, billingPeriodStart, billingPeriodEnd);
          if (exists) {
            console.log(`  Invoice already exists for period: ${billingPeriodStart.toISOString().split('T')[0]} to ${billingPeriodEnd.toISOString().split('T')[0]}`);
            // Move to next period
            billingStartDate = new Date(billingPeriodEnd);
            billingStartDate.setUTCDate(billingStartDate.getUTCDate() + 1); // Use UTC
            continue;
          }

          // Create invoice
          const invoice = await createInvoice(lead, billingPeriodStart, billingPeriodEnd, systemUser.id);
          console.log(`  ✓ Generated: ${invoice.invoiceNumber} | Period: ${billingPeriodStart.toISOString().split('T')[0]} to ${billingPeriodEnd.toISOString().split('T')[0]} | Amount: ₹${invoice.grandTotal}`);

          invoicesForThisLead++;
          totalInvoicesGenerated++;

          // Move to next billing period
          billingStartDate = new Date(billingPeriodEnd);
          billingStartDate.setUTCDate(billingStartDate.getUTCDate() + 1); // Use UTC
        }

        if (invoicesForThisLead > 0) {
          console.log(`  Total invoices generated for this lead: ${invoicesForThisLead}`);
        }

      } catch (leadError) {
        console.error(`[Invoice Job] Error processing lead ${lead.id}:`, leadError.message);
      }
    }

    console.log(`\n[Invoice Job] Completed. Total invoices generated: ${totalInvoicesGenerated}`);

    // Notify accounts team if any invoices were generated
    if (totalInvoicesGenerated > 0) {
      emitSidebarRefreshByRole('ACCOUNTS_TEAM');
      emitSidebarRefreshByRole('SUPER_ADMIN');
    }

  } catch (error) {
    console.error('[Invoice Job] Error:', error);
  }
};

/**
 * Mark overdue invoices
 * Invoices past due date that aren't paid should be marked as OVERDUE
 */
const markOverdueInvoices = async () => {
  try {
    const now = new Date();

    const result = await prisma.invoice.updateMany({
      where: {
        status: { in: ['GENERATED', 'PARTIALLY_PAID'] },
        dueDate: { lt: now }
      },
      data: {
        status: 'OVERDUE'
      }
    });

    if (result.count > 0) {
      console.log(`[Invoice Job] Marked ${result.count} invoices as OVERDUE`);
      emitSidebarRefreshByRole('ACCOUNTS_TEAM');
      emitSidebarRefreshByRole('SUPER_ADMIN');
    }

  } catch (error) {
    console.error('[Invoice Job] Error marking overdue invoices:', error);
  }
};

/**
 * Start the invoice generation cron job
 * Runs every day at 1:00 AM
 */
let isJobRunning = false;

const runInvoiceJob = async (source) => {
  if (isJobRunning) {
    console.log(`[Invoice Job] Skipping ${source} run - previous run still in progress`);
    return;
  }
  isJobRunning = true;
  try {
    console.log(`[Invoice Job] Running ${source} invoice generation...`);
    await generatePendingInvoices();
    await markOverdueInvoices();
  } finally {
    isJobRunning = false;
  }
};

export const startInvoiceGenerationJob = () => {
  // Run daily at 1:00 AM
  cron.schedule('0 1 * * *', () => {
    runInvoiceJob('scheduled');
  });

  console.log('[Invoice Job] Scheduled to run daily at 1:00 AM');

  // Also run immediately on startup
  setTimeout(() => {
    runInvoiceJob('startup');
  }, 5000); // Wait 5 seconds after startup
};

/**
 * Generate invoices for a specific lead (called immediately after plan creation)
 * This ensures invoices are generated right away without waiting for the daily job
 */
export const generateInvoiceForLead = async (leadId, userId) => {
  try {
    const now = normalizeDate(new Date());
    console.log(`[Invoice Job] Generating invoice for lead ${leadId}`);

    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      include: {
        campaignData: {
          select: { company: true, name: true, phone: true, email: true, city: true, state: true, address: true }
        },
        invoices: {
          where: {
            // Exclude OTC invoices when finding the last billing invoice
            planName: { not: 'One Time Charge (OTC)' }
          },
          orderBy: { billingPeriodEnd: 'desc' },
          take: 1
        }
      }
    });

    if (!lead || !lead.actualPlanName || !lead.actualPlanPrice || !lead.actualPlanIsActive) {
      console.log('[Invoice Job] Lead not eligible for invoice generation');
      return null;
    }

    const validityDays = lead.actualPlanValidityDays || 30;
    const billingType = lead.actualPlanBillingType || 'DAY_TO_DAY';
    const billingCycle = lead.actualPlanBillingCycle || 'MONTHLY';
    const lastInvoice = lead.invoices[0];

    // Determine the start date for billing
    let billingStartDate;
    if (lastInvoice) {
      billingStartDate = new Date(lastInvoice.billingPeriodEnd);
      billingStartDate.setUTCDate(billingStartDate.getUTCDate() + 1); // Use UTC to avoid timezone issues
    } else {
      billingStartDate = lead.actualPlanStartDate
        ? new Date(lead.actualPlanStartDate)
        : lead.actualPlanCreatedAt
          ? new Date(lead.actualPlanCreatedAt)
          : new Date();
    }

    billingStartDate = normalizeDate(billingStartDate);
    const billingPeriodStart = new Date(billingStartDate);
    const billingPeriodEnd = calculateBillingPeriodEnd(billingPeriodStart, billingCycle, validityDays, billingType);

    // Generate invoice immediately when plan is created (advance billing)
    // No date restriction - invoice is created as soon as plan is assigned
    console.log(`[Invoice Job] Billing period: ${billingPeriodStart.toISOString().split('T')[0]} to ${billingPeriodEnd.toISOString().split('T')[0]}`);

    // Check if invoice already exists
    const exists = await invoiceExistsForPeriod(leadId, billingPeriodStart, billingPeriodEnd);
    if (exists) {
      console.log('[Invoice Job] Invoice already exists for this period');
      return null;
    }

    // Create the invoice
    const invoice = await createInvoice(lead, billingPeriodStart, billingPeriodEnd, userId);
    console.log(`[Invoice Job] Generated: ${invoice.invoiceNumber} for ${lead.campaignData?.company}`);

    return invoice;
  } catch (error) {
    console.error('[Invoice Job] Error generating invoice for lead:', error);
    throw error;
  }
};

// Export for manual testing
export { generatePendingInvoices, markOverdueInvoices };

export default startInvoiceGenerationJob;
