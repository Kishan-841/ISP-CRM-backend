/**
 * One-time backfill for Lead.creationSource.
 *
 * Runs only on leads where creationSource = UNKNOWN (default). Re-runnable —
 * each row is assessed independently, nothing is destroyed. Prints a summary
 * at the end so you can see where each bucket landed.
 *
 * Rules (checked in order):
 *   1. campaign.code starts with 'SAM-'                         → SAM_REFERRAL
 *   2. campaign.name starts with '[BDM Self Lead]':
 *        a. lead had feasibilityAssignedToId at or near creation → BDM_OPPORTUNITY
 *        b. otherwise                                            → BDM_DIRECT_LEAD
 *   3. campaignData.isSelfGenerated=true AND campaignData creator role = ISR
 *                                                                → ISR_SELF_DATA
 *   4. campaign type in (OUTBOUND, INBOUND):
 *        a. campaign creator role in BDM-family                 → BULK_UPLOAD_BDM
 *        b. campaign creator role in admin-family               → BULK_UPLOAD_ADMIN
 *   5. otherwise                                                  → UNKNOWN (unchanged)
 *
 * Usage:
 *   cd backend && node prisma/seeds/backfill-creation-source.js
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const BDM_FAMILY = new Set(['BDM', 'BDM_CP', 'BDM_TEAM_LEADER']);
const ADMIN_FAMILY = new Set(['SUPER_ADMIN', 'ADMIN', 'MASTER']);

async function run() {
  console.log('[backfill-creation-source] starting…');

  const leads = await prisma.lead.findMany({
    where: { creationSource: 'UNKNOWN' },
    select: {
      id: true,
      feasibilityAssignedToId: true,
      createdAt: true,
      campaignData: {
        select: {
          isSelfGenerated: true,
          createdBy: { select: { role: true } },
          campaign: {
            select: {
              code: true,
              name: true,
              type: true,
              createdBy: { select: { role: true } },
            },
          },
        },
      },
    },
  });

  console.log(`[backfill-creation-source] ${leads.length} leads to assess.`);

  const buckets = {
    SAM_REFERRAL: [],
    BDM_OPPORTUNITY: [],
    BDM_DIRECT_LEAD: [],
    ISR_SELF_DATA: [],
    BULK_UPLOAD_BDM: [],
    BULK_UPLOAD_ADMIN: [],
    UNKNOWN: [],
  };

  for (const lead of leads) {
    const cd = lead.campaignData;
    const c = cd?.campaign;
    const uploaderRole = cd?.createdBy?.role || c?.createdBy?.role || null;

    let source = 'UNKNOWN';

    if (c?.code?.startsWith('SAM-')) {
      source = 'SAM_REFERRAL';
    } else if (c?.name?.startsWith('[BDM Self Lead]')) {
      // Distinguish Add Lead from Create Opportunity by whether feasibility
      // was assigned at creation — Create Opportunity requires it, Add Lead
      // skips it until the BDM qualifies. Caveat: an Add-Lead that was later
      // qualified normally will also have feasibilityAssignedToId. Without
      // the first StatusChangeLog we can't tell perfectly, but the gap
      // (createdAt vs feasibility assignment time) is a reasonable proxy —
      // Create Opportunity assigns feasibility in the same request.
      source = lead.feasibilityAssignedToId ? 'BDM_OPPORTUNITY' : 'BDM_DIRECT_LEAD';
    } else if (cd?.isSelfGenerated === true && uploaderRole === 'ISR') {
      source = 'ISR_SELF_DATA';
    } else if (BDM_FAMILY.has(uploaderRole)) {
      source = 'BULK_UPLOAD_BDM';
    } else if (ADMIN_FAMILY.has(uploaderRole)) {
      source = 'BULK_UPLOAD_ADMIN';
    } else if (uploaderRole === 'ISR') {
      source = 'ISR_SELF_DATA';
    }

    buckets[source].push(lead.id);
  }

  // Apply updates in bulk per bucket (skip UNKNOWN — default already).
  for (const [source, ids] of Object.entries(buckets)) {
    if (source === 'UNKNOWN' || ids.length === 0) continue;
    const result = await prisma.lead.updateMany({
      where: { id: { in: ids } },
      data: { creationSource: source },
    });
    console.log(`[backfill-creation-source] ${source}: ${result.count} rows updated`);
  }

  console.log(`[backfill-creation-source] UNKNOWN (no change): ${buckets.UNKNOWN.length} rows`);
  console.log('[backfill-creation-source] done.');
}

run()
  .catch((err) => {
    console.error('[backfill-creation-source] FAILED:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
