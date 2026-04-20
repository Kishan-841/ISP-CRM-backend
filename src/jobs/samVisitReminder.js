import cron from 'node-cron';
import prisma from '../config/db.js';
import { tryEmitReminder, windowMinutesAhead, cleanExpired } from '../services/reminderBus.js';

/**
 * SAM visit reminder — 30 minutes before a scheduled field visit.
 *
 * Field visits require travel; 5 min is too late. 30 min gives the SAM
 * executive time to review notes + head out. Cron runs every minute;
 * window is 28–32 min ahead of now.
 */

async function runCheck() {
  try {
    cleanExpired();
    const { windowStart, windowEnd } = windowMinutesAhead(28, 32);

    const visits = await prisma.sAMVisit.findMany({
      where: {
        visitDate: { gte: windowStart, lte: windowEnd },
        status: 'SCHEDULED',
      },
      select: {
        id: true, visitDate: true, visitType: true, purpose: true, location: true,
        samExecutiveId: true,
        customer: {
          select: { id: true, fullAddress: true, campaignData: { select: { name: true, company: true, phone: true } } },
        },
      },
    });

    let fired = 0;
    for (const v of visits) {
      const company = v.customer?.campaignData?.company || null;
      const contact = v.customer?.campaignData?.name || null;
      const address = v.location || v.customer?.fullAddress || null;
      const ok = tryEmitReminder({
        userId: v.samExecutiveId,
        type: 'SAM_VISIT',
        recordId: v.id,
        title: company ? `Visit: ${company}` : 'Customer Visit',
        subtitle: [contact, v.customer?.campaignData?.phone].filter(Boolean).join(' · ') || null,
        startAt: v.visitDate,
        ctaLabel: 'Open Visits',
        ctaHref: '/dashboard/sam-executive/visits',
        location: address,
        meta: { visitType: v.visitType, purpose: v.purpose, leadId: v.customer?.id || null },
      });
      if (ok) fired++;
    }

    if (fired > 0) {
      console.log(`[SamVisitReminder] fired for ${fired} SAM visits`);
    }
  } catch (err) {
    console.error('[SamVisitReminder] check failed:', err);
  }
}

export function startSamVisitReminderJob() {
  cron.schedule('* * * * *', runCheck);
  console.log('[SamVisitReminder] Scheduled: every minute, 30-min-before popups');
  runCheck();
}
