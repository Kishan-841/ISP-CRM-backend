import cron from 'node-cron';
import prisma from '../config/db.js';
import { emitToUser } from '../sockets/index.js';

/**
 * Meeting reminder job.
 *
 * Runs every minute and fires a `meeting:reminder` socket event 5 minutes
 * before each scheduled meeting — both SAM executive meetings and BDM
 * pipeline meetings (Lead.meetingDate + status=MEETING_SCHEDULED). The
 * frontend renders a modal when it receives the event.
 *
 * Window: meetings starting 4-6 minutes from now — a 2-minute band absorbs
 * cron-tick drift and slow DB queries. Dedup key: `<source>|<meetingId>`
 * kept for 15 minutes so the same meeting never triggers twice.
 */

const REMINDER_LEAD_MIN = 4;   // minutes (start of window)
const REMINDER_LEAD_MAX = 6;   // minutes (end of window)
const DEDUP_TTL_MS = 15 * 60 * 1000;

const sentReminders = new Map();  // Map<key, firedAt>

function cleanExpired() {
  const cutoff = Date.now() - DEDUP_TTL_MS;
  for (const [k, t] of sentReminders) if (t < cutoff) sentReminders.delete(k);
}

async function fireSamMeetingReminders(windowStart, windowEnd) {
  const meetings = await prisma.sAMMeeting.findMany({
    where: {
      meetingDate: { gte: windowStart, lte: windowEnd },
      status: { in: ['SCHEDULED'] },   // ignore COMPLETED / CANCELLED
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
        select: {
          id: true,
          campaignData: { select: { name: true, company: true } },
        },
      },
    },
  });

  for (const m of meetings) {
    const key = `SAM|${m.id}`;
    if (sentReminders.has(key)) continue;
    sentReminders.set(key, Date.now());

    emitToUser(m.samExecutiveId, 'meeting:reminder', {
      meetingId: m.id,
      source: 'SAM',
      title: m.title,
      startAt: m.meetingDate,
      meetingType: m.meetingType,
      location: m.location,
      meetingLink: m.meetingLink,
      customerName: m.customer?.campaignData?.name || null,
      companyName: m.customer?.campaignData?.company || null,
      leadId: m.customer?.id || null,
    });
  }
  return meetings.length;
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

  for (const l of leads) {
    const key = `BDM|${l.id}`;
    if (sentReminders.has(key)) continue;
    sentReminders.set(key, Date.now());

    const companyName = l.campaignData?.company || null;
    const title = companyName ? `Meeting with ${companyName}` : 'Customer Meeting';

    emitToUser(l.assignedToId, 'meeting:reminder', {
      meetingId: l.id,
      source: 'BDM',
      title,
      startAt: l.meetingDate,
      location: l.meetingPlace,
      meetingLink: null,
      customerName: l.campaignData?.name || null,
      companyName,
      leadId: l.id,
      notes: l.meetingNotes,
    });
  }
  return leads.length;
}

async function runReminderCheck() {
  try {
    cleanExpired();
    const now = Date.now();
    const windowStart = new Date(now + REMINDER_LEAD_MIN * 60 * 1000);
    const windowEnd = new Date(now + REMINDER_LEAD_MAX * 60 * 1000);

    const [sam, bdm] = await Promise.all([
      fireSamMeetingReminders(windowStart, windowEnd),
      fireBdmMeetingReminders(windowStart, windowEnd),
    ]);

    if (sam + bdm > 0) {
      console.log(`[MeetingReminder] Window ${windowStart.toISOString()} → ${windowEnd.toISOString()}: fired for ${sam} SAM + ${bdm} BDM meetings`);
    }
  } catch (err) {
    console.error('[MeetingReminder] check failed:', err);
  }
}

export function startMeetingReminderJob() {
  // Every minute at :00. A 2-min window (4-6 min before meeting) absorbs
  // any one-minute drift, so the reminder still lands close to T-5.
  cron.schedule('* * * * *', runReminderCheck);
  console.log('[MeetingReminder] Scheduled: every minute, 5-min-before reminders');

  // Fire once on boot so reminders for meetings coming up in the window
  // don't wait another minute after a deploy.
  runReminderCheck();
}
