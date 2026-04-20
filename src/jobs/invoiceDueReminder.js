import cron from 'node-cron';
import prisma from '../config/db.js';
import { tryEmitReminder, cleanExpired } from '../services/reminderBus.js';

/**
 * Invoice due reminder — 3 days before an unpaid invoice's due date.
 *
 * Runs once a day at 9 AM IST (schedule in IST timezone). Finds invoices
 * whose `dueDate` falls exactly within the 24-hour window 3 days from now,
 * and sends a `reminder:show` to every ACTIVE ACCOUNTS_TEAM user so they
 * can proactively chase collections.
 *
 * Skips: PAID, CANCELLED. Partially paid is still chased — any remaining
 * amount is worth a reminder.
 */

async function runCheck() {
  try {
    cleanExpired();
    const now = new Date();
    // Start of "3 days from now" (midnight) to start of "4 days from now"
    const dayStart = new Date(now);
    dayStart.setDate(dayStart.getDate() + 3);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const [accountsUsers, invoices] = await Promise.all([
      prisma.user.findMany({
        where: { role: 'ACCOUNTS_TEAM', isActive: true },
        select: { id: true },
      }),
      prisma.invoice.findMany({
        where: {
          dueDate: { gte: dayStart, lt: dayEnd },
          status: { in: ['GENERATED', 'SENT', 'PARTIALLY_PAID', 'OVERDUE'] },
        },
        select: {
          id: true, invoiceNumber: true, grandTotal: true, remainingAmount: true,
          totalPaidAmount: true, dueDate: true,
          lead: {
            select: { id: true, campaignData: { select: { company: true, name: true, phone: true } } },
          },
        },
      }),
    ]);

    if (invoices.length === 0 || accountsUsers.length === 0) {
      console.log(`[InvoiceDueReminder] no due-soon invoices (${invoices.length}) or no active accounts users (${accountsUsers.length})`);
      return;
    }

    let fired = 0;
    for (const inv of invoices) {
      const company = inv.lead?.campaignData?.company || null;
      const contact = inv.lead?.campaignData?.name || null;
      const remaining = Number(inv.remainingAmount ?? (inv.grandTotal - (inv.totalPaidAmount || 0)));
      const subtitle = [company || contact, `₹${remaining.toFixed(2)} due`].filter(Boolean).join(' · ');

      // Fire one per accounts user — each gets their own dedup key
      for (const u of accountsUsers) {
        const ok = tryEmitReminder({
          userId: u.id,
          type: 'INVOICE_DUE',
          recordId: `${inv.id}:${u.id}`,
          title: `Due in 3 days · ${inv.invoiceNumber}`,
          subtitle,
          startAt: inv.dueDate,
          ctaLabel: 'Open Billing',
          // The billing page is nested under the lead: /dashboard/billing-mgmt/<leadId>
          ctaHref: inv.lead?.id ? `/dashboard/billing-mgmt/${inv.lead.id}` : '/dashboard/billing-mgmt',
          meta: {
            invoiceId: inv.id,
            invoiceNumber: inv.invoiceNumber,
            amountDue: remaining,
            customerPhone: inv.lead?.campaignData?.phone || null,
            leadId: inv.lead?.id || null,
          },
        });
        if (ok) fired++;
      }
    }
    console.log(`[InvoiceDueReminder] fired ${fired} reminders for ${invoices.length} invoice(s) × ${accountsUsers.length} accounts user(s)`);
  } catch (err) {
    console.error('[InvoiceDueReminder] check failed:', err);
  }
}

export function startInvoiceDueReminderJob() {
  // 9 AM IST daily. Node-cron respects server timezone; set TZ via .env (Docker usually runs UTC).
  cron.schedule('0 9 * * *', runCheck, { timezone: 'Asia/Kolkata' });
  console.log('[InvoiceDueReminder] Scheduled: daily at 9 AM IST, 3-days-before-due popups');
}
