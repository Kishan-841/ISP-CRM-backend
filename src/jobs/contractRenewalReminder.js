import cron from 'node-cron';
import prisma from '../config/db.js';
import { createNotification } from '../services/notification.service.js';

// Dedup cache: Map<string, timestamp> to avoid repeat notifications
const notifiedContracts = new Map();
const DEDUP_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7 days

function cleanupCache() {
  const now = Date.now();
  for (const [key, timestamp] of notifiedContracts) {
    if (now - timestamp > DEDUP_EXPIRY) {
      notifiedContracts.delete(key);
    }
  }
}

/**
 * Contract Renewal Reminder
 * Runs daily at 9:00 AM
 * Checks for contracts expiring within 30, 15, and 7 days
 * Notifies the assigned SAM Executive (and SAM_HEAD at 30 days)
 */
export function startContractRenewalReminder() {
  // Run daily at 9:00 AM
  cron.schedule('0 9 * * *', async () => {
    console.log('[ContractRenewalReminder] Running contract renewal check...');
    cleanupCache();

    try {
      const now = new Date();
      const milestones = [
        { days: 30, label: '30 days', notifyHead: true },
        { days: 15, label: '15 days', notifyHead: false },
        { days: 7, label: '7 days', notifyHead: false },
      ];

      for (const milestone of milestones) {
        const targetDate = new Date(now.getTime() + milestone.days * 24 * 60 * 60 * 1000);
        const targetStart = new Date(targetDate);
        targetStart.setUTCHours(0, 0, 0, 0);
        const targetEnd = new Date(targetDate);
        targetEnd.setUTCHours(23, 59, 59, 999);

        // Find customers with contractEndDate matching this milestone day
        const expiringCustomers = await prisma.lead.findMany({
          where: {
            customerUserId: { not: null },
            contractEndDate: {
              gte: targetStart,
              lte: targetEnd,
            },
            samAssignment: { isNot: null },
          },
          select: {
            id: true,
            contractEndDate: true,
            campaignData: {
              select: { company: true, name: true }
            },
            samAssignment: {
              select: {
                samExecutiveId: true,
              }
            }
          }
        });

        for (const customer of expiringCustomers) {
          const dedupKey = `${customer.id}-${milestone.days}`;
          if (notifiedContracts.has(dedupKey)) continue;

          const companyName = customer.campaignData?.company || 'Unknown Customer';
          const executiveId = customer.samAssignment?.samExecutiveId;

          if (executiveId) {
            await createNotification(
              executiveId,
              'CONTRACT_RENEWAL',
              'Contract Expiring Soon',
              `${companyName} contract expires in ${milestone.label}. Please initiate renewal.`,
              { leadId: customer.id, daysUntilExpiry: milestone.days }
            );
          }

          // Notify SAM_HEAD at 30-day milestone
          if (milestone.notifyHead) {
            const samHeads = await prisma.user.findMany({
              where: { role: 'SAM_HEAD', isActive: true },
              select: { id: true }
            });
            for (const head of samHeads) {
              await createNotification(
                head.id,
                'CONTRACT_RENEWAL',
                'Contract Expiring - 30 Day Alert',
                `${companyName} contract expires in 30 days. Assigned executive has been notified.`,
                { leadId: customer.id, daysUntilExpiry: 30 }
              );
            }
          }

          notifiedContracts.set(dedupKey, Date.now());
        }

        if (expiringCustomers.length > 0) {
          console.log(`[ContractRenewalReminder] Found ${expiringCustomers.length} contracts expiring in ${milestone.label}`);
        }
      }

      console.log('[ContractRenewalReminder] Check complete.');
    } catch (error) {
      console.error('[ContractRenewalReminder] Error:', error);
    }
  });

  console.log('[ContractRenewalReminder] Scheduled: daily at 9:00 AM');
}
