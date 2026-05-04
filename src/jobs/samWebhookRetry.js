import cron from 'node-cron';
import prisma from '../config/db.js';
import { attemptDelivery } from '../services/samWebhook.service.js';

const BATCH_LIMIT = 50;

// Retry sweep for the SAM activation webhook outbox.
// Runs every minute. Picks up PENDING rows whose nextAttemptAt has
// elapsed and re-attempts delivery. The service module owns all the
// status/backoff logic — this job just selects work and dispatches it.
//
// Single-instance assumption: in production with multiple backends you'd
// want SELECT ... FOR UPDATE SKIP LOCKED to prevent two instances picking
// the same row. For now (single-node dev/prod), the sequential per-row
// loop and 1-min cadence make collisions effectively impossible.

export function startSamWebhookRetryJob() {
  if (!process.env.SAM_WEBHOOK_URL || !process.env.SAM_WEBHOOK_SECRET) {
    console.warn(
      '[SamWebhookRetry] SAM_WEBHOOK_URL / SAM_WEBHOOK_SECRET not set; retry job will be inert.'
    );
  }

  cron.schedule('* * * * *', async () => {
    if (!process.env.SAM_WEBHOOK_URL || !process.env.SAM_WEBHOOK_SECRET) return;
    try {
      const due = await prisma.samWebhookLog.findMany({
        where: {
          status: 'PENDING',
          nextAttemptAt: { lte: new Date() },
        },
        orderBy: { nextAttemptAt: 'asc' },
        take: BATCH_LIMIT,
        select: { id: true },
      });
      if (due.length === 0) return;
      console.log(`[SamWebhookRetry] Retrying ${due.length} pending webhook(s)`);
      for (const row of due) {
        await attemptDelivery(row.id);
      }
    } catch (err) {
      console.error('[SamWebhookRetry] sweep error:', err);
    }
  });

  console.log('[SamWebhookRetry] Job started — sweeping every minute');
}
