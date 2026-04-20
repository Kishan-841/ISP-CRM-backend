import cron from 'node-cron';
import prisma from '../config/db.js';
import { tryEmitReminder, windowMinutesAhead, cleanExpired } from '../services/reminderBus.js';

/**
 * Meeting reminder — fires a `reminder:show` socket event 5 minutes before
 * each scheduled meeting. Covers both meeting models:
 *   - SAMMeeting (post-sale SAM executive meetings) → samExecutiveId
 *   - Lead.meetingDate + status=MEETING_SCHEDULED     → lead.assignedToId
 *
 * Window: 4–6 min from now (2-min band absorbs cron-tick drift so the
 * reminder still lands ~T-5). Dedup handled by the shared reminderBus.
 */

async function fireSamMeetingReminders(windowStart, windowEnd) {
  const meetings = await prisma.sAMMeeting.findMany({
    where: {
      meetingDate: { gte: windowStart, lte: windowEnd },
      // sam.controller.js hardcodes status:'COMPLETED' for backward-looking
      // MOM flow, but users may also store future-dated meetings. Remind on
      // any non-cancelled future-dated row.
      status: { not: 'CANCELLED' },
    },
    select: {
      id: true,
      title: true,
      meetingDate: true,
      meetingType: true,
      location: true,
      meetingLink: true,
      samExecutiveId: true,
      customer: {
        select: { id: true, campaignData: { select: { name: true, company: true } } },
      },
    },
  });

  let fired = 0;
  for (const m of meetings) {
    const company = m.customer?.campaignData?.company || null;
    const contact = m.customer?.campaignData?.name || null;
    const ok = tryEmitReminder({
      userId: m.samExecutiveId,
      type: 'MEETING_SAM',
      recordId: m.id,
      title: m.title || (company ? `Meeting with ${company}` : 'SAM Meeting'),
      subtitle: [contact, company].filter(Boolean).join(' · ') || null,
      startAt: m.meetingDate,
      ctaLabel: 'Open Meetings',
      ctaHref: '/dashboard/sam-executive/meetings',
      joinLink: m.meetingLink,
      location: m.location,
      meta: { meetingType: m.meetingType, leadId: m.customer?.id || null },
    });
    if (ok) fired++;
  }
  return fired;
}

async function fireBdmMeetingReminders(windowStart, windowEnd) {
  const leads = await prisma.lead.findMany({
    where: {
      meetingDate: { gte: windowStart, lte: windowEnd },
      status: 'MEETING_SCHEDULED',
      assignedToId: { not: null },
    },
    select: {
      id: true,
      meetingDate: true,
      meetingPlace: true,
      meetingNotes: true,
      assignedToId: true,
      campaignData: { select: { name: true, company: true } },
    },
  });

  let fired = 0;
  for (const l of leads) {
    const company = l.campaignData?.company || null;
    const contact = l.campaignData?.name || null;
    const ok = tryEmitReminder({
      userId: l.assignedToId,
      type: 'MEETING_BDM',
      recordId: l.id,
      title: company ? `Meeting with ${company}` : 'Customer Meeting',
      subtitle: [contact, company].filter(Boolean).join(' · ') || null,
      startAt: l.meetingDate,
      ctaLabel: 'Open Meetings',
      ctaHref: '/dashboard/bdm-meetings',
      location: l.meetingPlace,
      meta: { leadId: l.id, notes: l.meetingNotes },
    });
    if (ok) fired++;
  }
  return fired;
}

async function runCheck() {
  try {
    cleanExpired();
    const { windowStart, windowEnd } = windowMinutesAhead(4, 6);
    const [sam, bdm] = await Promise.all([
      fireSamMeetingReminders(windowStart, windowEnd),
      fireBdmMeetingReminders(windowStart, windowEnd),
    ]);
    if (sam + bdm > 0) {
      console.log(`[MeetingReminder] fired for ${sam} SAM + ${bdm} BDM meetings`);
    }
  } catch (err) {
    console.error('[MeetingReminder] check failed:', err);
  }
}

export function startMeetingReminderJob() {
  cron.schedule('* * * * *', runCheck);
  console.log('[MeetingReminder] Scheduled: every minute, 5-min-before reminders');
  runCheck();
}
