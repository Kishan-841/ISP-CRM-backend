import cron from 'node-cron';
import prisma from '../config/db.js';
import { notifyFollowUpReminder, notifyBDMFollowUpReminder } from '../services/notification.service.js';
import { emitSidebarRefresh } from '../sockets/index.js';

// Track sent reminders to avoid duplicates (in-memory cache, resets on server restart)
// Uses Map<key, timestamp> for time-based cleanup instead of unbounded Set growth
const sentReminders = new Map();
const sentBDMReminders = new Map();

/**
 * Remove entries older than maxAgeMs from the dedup map
 * Prevents unbounded memory growth without losing all dedup info at once
 */
function cleanExpiredEntries(map, maxAgeMs = 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  for (const [key, timestamp] of map) {
    if (timestamp < cutoff) {
      map.delete(key);
    }
  }
}

/**
 * Check for follow-ups that are due within the next hour and send reminders
 */
const checkFollowUpReminders = async () => {
  try {
    cleanExpiredEntries(sentReminders);

    const now = new Date();
    const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);

    // Find follow-ups due within the next hour
    const upcomingFollowUps = await prisma.campaignData.findMany({
      where: {
        status: 'CALL_LATER',
        callLaterAt: {
          gte: now,
          lte: oneHourFromNow
        },
        assignedToId: { not: null }
      },
      include: {
        campaign: {
          select: { name: true }
        }
      }
    });

    for (const followUp of upcomingFollowUps) {
      // Create a unique key for this reminder
      const reminderKey = `${followUp.id}-${followUp.callLaterAt.toISOString().slice(0, 13)}`;

      // Skip if already sent
      if (sentReminders.has(reminderKey)) {
        continue;
      }

      // Check if a reminder notification was already sent for this follow-up today
      const existingReminder = await prisma.notification.findFirst({
        where: {
          userId: followUp.assignedToId,
          type: 'FOLLOW_UP_REMINDER',
          createdAt: {
            gte: new Date(now.getTime() - 2 * 60 * 60 * 1000) // Within last 2 hours
          },
          metadata: {
            path: ['dataId'],
            equals: followUp.id
          }
        }
      });

      if (existingReminder) {
        sentReminders.set(reminderKey, Date.now());
        continue;
      }

      // Calculate time until follow-up
      const minutesUntil = Math.round((followUp.callLaterAt.getTime() - now.getTime()) / (60 * 1000));

      // Send reminder notification
      await notifyFollowUpReminder(followUp.assignedToId, {
        dataId: followUp.id,
        company: followUp.company,
        name: followUp.name,
        phone: followUp.phone,
        scheduledTime: followUp.callLaterAt,
        campaignName: followUp.campaign?.name,
        minutesUntil
      });
      emitSidebarRefresh(followUp.assignedToId);

      // Mark as sent
      sentReminders.set(reminderKey, Date.now());

      console.log(`Follow-up reminder sent to ${followUp.assignedToId} for ${followUp.company} (due in ${minutesUntil} minutes)`);
    }

  } catch (error) {
    console.error('Follow-up reminder job error:', error);
  }
};

/**
 * Check for BDM lead follow-ups that are due within the next hour and send reminders
 */
const checkBDMFollowUpReminders = async () => {
  try {
    cleanExpiredEntries(sentBDMReminders);

    const now = new Date();
    const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);

    // Find BDM lead follow-ups due within the next hour
    const upcomingFollowUps = await prisma.lead.findMany({
      where: {
        status: 'FOLLOW_UP',
        callLaterAt: {
          gte: now,
          lte: oneHourFromNow
        },
        assignedToId: { not: null }
      },
      include: {
        campaignData: {
          include: {
            campaign: {
              select: { name: true }
            }
          }
        }
      }
    });

    for (const followUp of upcomingFollowUps) {
      // Create a unique key for this reminder
      const reminderKey = `lead-${followUp.id}-${followUp.callLaterAt.toISOString().slice(0, 13)}`;

      // Skip if already sent
      if (sentBDMReminders.has(reminderKey)) {
        continue;
      }

      // Check if a reminder notification was already sent for this lead recently
      const existingReminder = await prisma.notification.findFirst({
        where: {
          userId: followUp.assignedToId,
          type: 'FOLLOW_UP_REMINDER',
          createdAt: {
            gte: new Date(now.getTime() - 2 * 60 * 60 * 1000) // Within last 2 hours
          },
          metadata: {
            path: ['leadId'],
            equals: followUp.id
          }
        }
      });

      if (existingReminder) {
        sentBDMReminders.set(reminderKey, Date.now());
        continue;
      }

      // Calculate time until follow-up
      const minutesUntil = Math.round((followUp.callLaterAt.getTime() - now.getTime()) / (60 * 1000));

      // Send reminder notification
      await notifyBDMFollowUpReminder(followUp.assignedToId, {
        leadId: followUp.id,
        company: followUp.company,
        name: followUp.name,
        phone: followUp.phone,
        scheduledTime: followUp.callLaterAt,
        campaignName: followUp.campaignData?.campaign?.name,
        minutesUntil
      });
      emitSidebarRefresh(followUp.assignedToId);

      // Mark as sent
      sentBDMReminders.set(reminderKey, Date.now());

      console.log(`BDM follow-up reminder sent to ${followUp.assignedToId} for ${followUp.company} (due in ${minutesUntil} minutes)`);
    }

  } catch (error) {
    console.error('BDM follow-up reminder job error:', error);
  }
};

/**
 * Start the follow-up reminder cron job
 * Runs every 5 minutes for both ISR and BDM
 */
export const startFollowUpReminderJob = () => {
  // Run every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    console.log('Running follow-up reminder check...');
    checkFollowUpReminders();
    checkBDMFollowUpReminders();
  });

  console.log('Follow-up reminder job scheduled (every 5 minutes) - ISR & BDM');

  // Also run immediately on startup
  checkFollowUpReminders();
  checkBDMFollowUpReminders();
};

export default startFollowUpReminderJob;
