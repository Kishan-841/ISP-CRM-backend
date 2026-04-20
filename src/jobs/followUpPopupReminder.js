import cron from 'node-cron';
import prisma from '../config/db.js';
import { tryEmitReminder, windowMinutesAhead, cleanExpired } from '../services/reminderBus.js';

/**
 * Follow-up popup reminder — 5 min before a scheduled callback.
 *
 * Separate from the existing `followUpReminder.js` (which sends hour-window
 * notification toasts). This one is the urgent in-your-face modal:
 *   - ISR: CampaignData.callLaterAt, status=CALL_LATER, assignedToId (ISR)
 *   - BDM: Lead.callLaterAt, status=FOLLOW_UP, assignedToId (BDM)
 *
 * Window: 4–6 min ahead. Runs every minute.
 */

async function fireIsrFollowUpReminders(windowStart, windowEnd) {
  const contacts = await prisma.campaignData.findMany({
    where: {
      callLaterAt: { gte: windowStart, lte: windowEnd },
      status: 'CALL_LATER',
      assignedToId: { not: null },
    },
    select: {
      id: true, name: true, company: true, phone: true,
      callLaterAt: true, assignedToId: true,
      campaign: { select: { name: true } },
    },
  });

  let fired = 0;
  for (const c of contacts) {
    const ok = tryEmitReminder({
      userId: c.assignedToId,
      type: 'FOLLOW_UP_ISR',
      recordId: c.id,
      title: c.company ? `Callback: ${c.company}` : `Callback: ${c.name || 'Contact'}`,
      subtitle: [c.name, c.phone].filter(Boolean).join(' · ') || null,
      startAt: c.callLaterAt,
      ctaLabel: 'Open Calling Queue',
      ctaHref: '/dashboard/retry-calls',
      meta: { campaignDataId: c.id, campaignName: c.campaign?.name || null, phone: c.phone },
    });
    if (ok) fired++;
  }
  return fired;
}

async function fireBdmFollowUpReminders(windowStart, windowEnd) {
  const leads = await prisma.lead.findMany({
    where: {
      callLaterAt: { gte: windowStart, lte: windowEnd },
      status: 'FOLLOW_UP',
      assignedToId: { not: null },
    },
    select: {
      id: true, leadNumber: true, callLaterAt: true, assignedToId: true,
      campaignData: { select: { name: true, company: true, phone: true } },
    },
  });

  let fired = 0;
  for (const l of leads) {
    const company = l.campaignData?.company || null;
    const contact = l.campaignData?.name || null;
    const ok = tryEmitReminder({
      userId: l.assignedToId,
      type: 'FOLLOW_UP_BDM',
      recordId: l.id,
      title: company ? `Follow-up: ${company}` : `Follow-up: ${contact || 'Lead'}`,
      subtitle: [contact, l.campaignData?.phone].filter(Boolean).join(' · ') || null,
      startAt: l.callLaterAt,
      ctaLabel: 'Open Follow-Ups',
      ctaHref: '/dashboard/bdm-follow-ups',
      meta: { leadId: l.id, leadNumber: l.leadNumber, phone: l.campaignData?.phone || null },
    });
    if (ok) fired++;
  }
  return fired;
}

async function runCheck() {
  try {
    cleanExpired();
    const { windowStart, windowEnd } = windowMinutesAhead(4, 6);
    const [isr, bdm] = await Promise.all([
      fireIsrFollowUpReminders(windowStart, windowEnd),
      fireBdmFollowUpReminders(windowStart, windowEnd),
    ]);
    if (isr + bdm > 0) {
      console.log(`[FollowUpPopup] fired for ${isr} ISR + ${bdm} BDM follow-ups`);
    }
  } catch (err) {
    console.error('[FollowUpPopup] check failed:', err);
  }
}

export function startFollowUpPopupJob() {
  cron.schedule('* * * * *', runCheck);
  console.log('[FollowUpPopup] Scheduled: every minute, 5-min-before popups (ISR + BDM)');
  runCheck();
}
