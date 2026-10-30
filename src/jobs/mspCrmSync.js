import cron from 'node-cron';
import {
  isConfigured,
  syncMspStatuses,
  sendLeadToMsp,
  findDueSends,
} from '../services/mspCrm.service.js';

const SEND_BATCH_LIMIT = 25;

/**
 * MSP CRM sync — one job, two responsibilities, every five minutes.
 *
 *   1. Retry sends that failed transiently. Safe because their POST /leads is
 *      idempotent on externalRef.
 *   2. Pull status changes since the cursor they gave us.
 *
 * Sends run first so a lead that only just went out still gets its status in
 * the same tick rather than waiting another five minutes.
 *
 * Single-instance assumption, same as the SAM webhook retry job: with several
 * backend processes you would want SELECT ... FOR UPDATE SKIP LOCKED so two
 * instances cannot pick the same lead. At this cadence on one node, a
 * collision is effectively impossible — and a double send is harmless anyway,
 * since their API returns the same lead for a repeated externalRef.
 */
export function startMspCrmSyncJob() {
  if (!isConfigured()) {
    console.warn(
      '[MspCrm] MSP_CRM_API_URL / MSP_CRM_API_KEY not set; sync job will be inert.'
    );
  }

  cron.schedule('*/5 * * * *', async () => {
    if (!isConfigured()) return;

    // ── 1. retry pending sends ───────────────────────────────────────────
    try {
      const due = await findDueSends(SEND_BATCH_LIMIT);
      if (due.length > 0) {
        console.log(`[MspCrm] Retrying ${due.length} pending send(s)`);
        for (const lead of due) {
          // Sequential on purpose: their rate limit is 120/min and a burst of
          // parallel retries is the easiest way to trip it.
          await sendLeadToMsp(lead.id);
        }
      }
    } catch (err) {
      // A failure here must not stop the status sync below.
      console.error('[MspCrm] Send retry sweep error:', err);
    }

    // ── 2. pull status changes ───────────────────────────────────────────
    try {
      const result = await syncMspStatuses();
      if (result.ok) {
        if (result.updated || result.removed) {
          console.log(
            `[MspCrm] Status sync: ${result.updated} updated, ${result.removed} removed, ${result.pages} page(s)`
          );
        }
      } else {
        console.error(`[MspCrm] Status sync incomplete: ${result.message}`);
      }
    } catch (err) {
      console.error('[MspCrm] Status sync error:', err);
    }
  });

  console.log('[MspCrm] Sync job started — every 5 minutes');
}
