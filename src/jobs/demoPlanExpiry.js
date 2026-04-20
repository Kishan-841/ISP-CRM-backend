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

// PostgreSQL advisory lock — works across multiple backend instances (future-
// proofing for a multi-replica deploy). The in-memory `isRunning` guard
// underneath stays as a cheap local short-circuit when the same process
// tries to run concurrently (e.g. startup overlaps scheduled tick).
// Lock key is a stable integer so every replica agrees on the same lock.
const DEMO_PLAN_EXPIRY_LOCK_KEY = 74201001;  // arbitrary but unique per job
let isRunning = false;
const runJob = async (source) => {
  if (isRunning) {
    console.log(`[Demo Plan Expiry] Skipping ${source} run - local run in progress`);
    return;
  }
  isRunning = true;
  try {
    // Try to acquire the cross-instance lock. If another replica already has
    // it, we silently skip — the other instance is doing the work.
    let acquired = false;
    try {
      const rows = await prisma.$queryRaw`SELECT pg_try_advisory_lock(${DEMO_PLAN_EXPIRY_LOCK_KEY}::bigint) AS locked`;
      acquired = rows?.[0]?.locked === true;
    } catch (e) {
      console.error('[Demo Plan Expiry] Advisory lock query failed — falling back to local mutex only:', e);
      acquired = true; // don't block the job on lock failure
    }
    if (!acquired) {
      console.log('[Demo Plan Expiry] Another instance holds the lock — skipping.');
      return;
    }
    try {
      await expireDemoPlans();
    } finally {
      try {
        await prisma.$executeRaw`SELECT pg_advisory_unlock(${DEMO_PLAN_EXPIRY_LOCK_KEY}::bigint)`;
      } catch (e) {
        console.error('[Demo Plan Expiry] Advisory unlock failed (will auto-release on session end):', e);
      }
    }
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
