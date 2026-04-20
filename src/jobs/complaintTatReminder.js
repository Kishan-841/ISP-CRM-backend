import cron from 'node-cron';
import prisma from '../config/db.js';
import { tryEmitReminder, windowMinutesAhead, cleanExpired } from '../services/reminderBus.js';

/**
 * Complaint TAT breach reminder — 2 hours before the complaint's TAT deadline.
 *
 * Runs every 5 minutes. Window: 115–125 min ahead of now (10-minute band
 * because the cron is less frequent here).
 *
 * Only OPEN complaints trigger reminders. CLOSED complaints have already
 * been resolved so no action is needed.
 *
 * Reminder goes to every ACTIVE assignee of the complaint.
 */

async function runCheck() {
  try {
    cleanExpired();
    const { windowStart, windowEnd } = windowMinutesAhead(115, 125);

    const complaints = await prisma.complaint.findMany({
      where: {
        status: 'OPEN',
        tatDeadline: { gte: windowStart, lte: windowEnd },
      },
      select: {
        id: true,
        complaintNumber: true,
        tatDeadline: true,
        priority: true,
        description: true,
        lead: {
          select: { id: true, campaignData: { select: { name: true, company: true } } },
        },
        category: { select: { name: true } },
        subCategory: { select: { name: true } },
        assignments: {
          where: { isActive: true },
          select: { userId: true },
        },
      },
    });

    let fired = 0;
    for (const c of complaints) {
      if (!c.assignments.length) continue;
      const company = c.lead?.campaignData?.company || null;
      const contact = c.lead?.campaignData?.name || null;
      const cat = [c.category?.name, c.subCategory?.name].filter(Boolean).join(' / ');
      const subtitleParts = [];
      if (company) subtitleParts.push(company);
      else if (contact) subtitleParts.push(contact);
      if (cat) subtitleParts.push(cat);

      for (const a of c.assignments) {
        const ok = tryEmitReminder({
          userId: a.userId,
          type: 'COMPLAINT_TAT',
          // Key per-assignee so multiple assignees each get their own popup
          recordId: `${c.id}:${a.userId}`,
          title: `TAT in 2h · Complaint ${c.complaintNumber}`,
          subtitle: subtitleParts.join(' · ') || null,
          startAt: c.tatDeadline,
          ctaLabel: 'Open Complaint',
          ctaHref: `/dashboard/complaints/${c.id}`,
          meta: {
            complaintId: c.id,
            complaintNumber: c.complaintNumber,
            priority: c.priority,
            leadId: c.lead?.id || null,
          },
        });
        if (ok) fired++;
      }
    }

    if (fired > 0) {
      console.log(`[ComplaintTatReminder] fired for ${fired} complaint-assignee pairs`);
    }
  } catch (err) {
    console.error('[ComplaintTatReminder] check failed:', err);
  }
}

export function startComplaintTatReminderJob() {
  // Every 5 minutes — TAT is hour-scale, so finer than that wastes DB hits.
  cron.schedule('*/5 * * * *', runCheck);
  console.log('[ComplaintTatReminder] Scheduled: every 5 min, 2h-before-TAT popups');
  runCheck();
}
