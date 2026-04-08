import cron from 'node-cron';
import prisma from '../config/db.js';
import { emitSidebarRefreshByRole } from '../sockets/index.js';

/**
 * Finds every lead whose demo plan is still active but whose expiry date
 * has passed, and marks it inactive. Idempotent: a plan that's already
 * inactive, has no expiry, or whose actual plan is already live is left
 * alone.
 */
const expireDemoPlans = async () => {
  const now = new Date();
  try {
    const expired = await prisma.lead.findMany({
      where: {
        demoPlanIsActive: true,
        demoPlanEndDate: { not: null, lte: now },
        actualPlanIsActive: false,
      },
      select: { id: true, leadNumber: true, demoPlanName: true, demoPlanEndDate: true },
    });

    if (expired.length === 0) {
      return;
    }

    await prisma.lead.updateMany({
      where: { id: { in: expired.map((l) => l.id) } },
      data: { demoPlanIsActive: false },
    });

    for (const lead of expired) {
      console.log(
        `[Demo Plan Expiry] Deactivated ${lead.demoPlanName || 'demo plan'} on lead ${lead.leadNumber || lead.id} (expired ${lead.demoPlanEndDate?.toISOString()})`
      );
    }

    // Refresh the Accounts/Delivery sidebars so the toggle reflects the new state.
    emitSidebarRefreshByRole('ACCOUNTS_TEAM');
    emitSidebarRefreshByRole('DELIVERY_TEAM');
    emitSidebarRefreshByRole('SUPER_ADMIN');
  } catch (error) {
    console.error('[Demo Plan Expiry] Job failed:', error);
  }
};

let isRunning = false;
const runJob = async (source) => {
  if (isRunning) {
    console.log(`[Demo Plan Expiry] Skipping ${source} run - previous run still in progress`);
    return;
  }
  isRunning = true;
  try {
    await expireDemoPlans();
  } finally {
    isRunning = false;
  }
};

/**
 * Schedule: every 15 minutes. Demo plans are typically day-scale, so 15 min
 * latency is plenty; running more often would just waste DB hits.
 */
export const startDemoPlanExpiryJob = () => {
  cron.schedule('*/15 * * * *', () => {
    runJob('scheduled');
  });
  console.log('[Demo Plan Expiry] Scheduled to run every 15 minutes');

  // Run shortly after boot so plans that expired while the server was down
  // are handled on the next deploy.
  setTimeout(() => {
    runJob('startup');
  }, 10000);
};
