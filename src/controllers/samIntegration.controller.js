import prisma from '../config/db.js';
import { asyncHandler } from '../utils/controllerHelper.js';
import { hasAnyRole } from '../utils/roleHelper.js';
import { createNotification } from '../services/notification.service.js';
import { emitSidebarRefresh, emitSidebarRefreshByRole } from '../sockets/index.js';
import { generateLeadNumber } from '../services/documentNumber.service.js';

// SAM → CRM Create-Lead integration. SAM operators pick a BDM in their UI
// and fill a form; we receive the lead here, assign it to the chosen BDM,
// and stamp SAM-attribution columns so the BDM team can spot
// SAM-sourced leads at a glance.
//
// Both endpoints sit behind the existing SAM-service JWT (same auth SAM
// already uses for POST /service-orders) — see routes/samIntegration.routes.js.

const ALLOWED_BDM_ROLES = ['BDM_TEAM_LEADER', 'BDM', 'BDM_CP'];

// Maps internal Role enum values → the type strings the SAM dropdown groups
// by. BDM_CP collapses into SOLO_BDM because the SAM contract (§1) only
// distinguishes TEAM_LEADER vs SOLO_BDM today; CP BDMs still get assigned
// leads but render in the same bucket.
function roleToSamType(role) {
  if (role === 'BDM_TEAM_LEADER') return 'TEAM_LEADER';
  return 'SOLO_BDM';
}

// GET /api/integrations/sam/bdms
//
// Lists active BDM-family users so the SAM "Create Lead" form can populate
// its Assign-To dropdown. Sorted: TLs first, then solo BDMs alphabetically.
export const getBdmList = asyncHandler(async function getBdmList(req, res) {
  // Same auth surface SAM already uses for POST /service-orders — see route.
  if (!hasAnyRole(req.user, ['SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN', 'MASTER'])) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const users = await prisma.user.findMany({
    where: { role: { in: ALLOWED_BDM_ROLES }, isActive: true },
    select: { id: true, name: true, email: true, role: true },
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
  });

  const bdms = users.map(u => ({
    id: u.id,
    name: u.name,
    email: u.email,
    type: roleToSamType(u.role),
  }));

  // Sort: TEAM_LEADER first (matches SAM-side spec §2.1's grouping), then
  // solo by name. Default Prisma ordering ranks alphabetically by role
  // which would put BDM before BDM_TEAM_LEADER — explicit sort instead.
  bdms.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'TEAM_LEADER' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  res.json({ bdms });
});

// POST /api/integrations/sam/leads
//
// Synchronous lead creation. The SAM operator is waiting on a confirmation
// toast, so we return 201 with { lead.id, lead.leadNumber } on success or
// a specific 4xx on failure. The samLeadId is the dedupe key — second
// click on the same form returns 200 { deduped: true } with the original
// lead's reference.
export const createSamLead = asyncHandler(async function createSamLead(req, res) {
  if (!hasAnyRole(req.user, ['SAM_HEAD', 'SAM_EXECUTIVE', 'SUPER_ADMIN', 'MASTER'])) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const body = req.body || {};
  const samLeadId = body.samLeadId;
  const assignedTo = body.assignedTo || {};
  const lead = body.lead || {};
  const source = body.source || {};

  // Payload shape — keep parity with SAM-side spec §2.2.
  if (!samLeadId) return res.status(400).json({ message: 'samLeadId is required.' });
  if (!assignedTo.userId) return res.status(400).json({ message: 'assignedTo.userId is required.' });
  if (!lead.companyName?.trim()) return res.status(400).json({ message: 'lead.companyName is required.' });
  if (!lead.contactName?.trim()) return res.status(400).json({ message: 'lead.contactName is required.' });
  if (!lead.phone?.trim()) return res.status(400).json({ message: 'lead.phone is required.' });
  if (!source.system) return res.status(400).json({ message: 'source.system is required.' });
  if (!source.createdBy?.id || !source.createdBy?.email) {
    return res.status(400).json({ message: 'source.createdBy.{id,email} are required.' });
  }

  const phoneDigits = String(lead.phone).replace(/\D/g, '');
  if (phoneDigits.length !== 10) {
    return res.status(400).json({ message: 'Phone number must be exactly 10 digits.' });
  }

  // Idempotency — same samLeadId twice returns the existing row, no second
  // lead created. The UNIQUE constraint on Lead.samLeadId is what makes the
  // race safe; this lookup is just to return a clean 200 instead of a 409.
  const existing = await prisma.lead.findUnique({
    where: { samLeadId },
    select: {
      id: true,
      leadNumber: true,
      assignedToId: true,
      assignedTo: { select: { id: true, name: true } },
      createdAt: true,
    },
  });
  if (existing) {
    return res.json({
      lead: {
        id: existing.id,
        leadNumber: existing.leadNumber,
        assignedToUserId: existing.assignedToId,
        assignedToName: existing.assignedTo?.name || null,
        createdAt: existing.createdAt,
      },
      samLeadId,
      deduped: true,
    });
  }

  // Verify the chosen BDM is active + assignable. 404 distinguishes
  // "operator chose a stale dropdown entry" from "payload was malformed" (400).
  const bdm = await prisma.user.findUnique({
    where: { id: assignedTo.userId },
    select: { id: true, name: true, role: true, isActive: true },
  });
  if (!bdm || !bdm.isActive || !ALLOWED_BDM_ROLES.includes(bdm.role)) {
    return res.status(404).json({ message: 'Selected BDM is no longer assignable. Reload the BDM list and try again.' });
  }

  // Per-BDM [SAM Dispatch] campaign — mirrors the pattern createDirectLead
  // uses for [BDM Self Lead]. Each BDM owns their own SAM-dispatch campaign
  // so:
  //   (a) it shows up in their All Data tab (the WHERE filter checks
  //       createdById = me OR assignments.some.userId = me, so ownership
  //       is what makes the campaign visible to them).
  //   (b) one BDM can't see another BDM's SAM-sourced leads when drilling
  //       into the campaign — each BDM's view is naturally scoped.
  // SAM-operator attribution still lives on the Lead row itself
  // (samCreatedById/Name/Email/At), independent of which BDM owns the
  // campaign. Two distinct concerns.
  const samCampaignName = `[SAM Dispatch] ${bdm.name}`;
  let samCampaign = await prisma.campaign.findFirst({
    where: { name: samCampaignName, type: 'SELF', createdById: bdm.id },
    select: { id: true },
  });
  if (!samCampaign) {
    // Generate a unique CMP code — same retry-on-collision pattern as
    // createDirectLead since CMP codes are also unique on Campaign.
    let retries = 3;
    while (retries > 0) {
      try {
        const latest = await prisma.campaign.findFirst({
          where: { code: { startsWith: 'CMP' } },
          orderBy: { code: 'desc' },
          select: { code: true },
        });
        let maxNumber = 0;
        if (latest?.code) {
          const match = latest.code.match(/CMP(\d+)/);
          if (match) maxNumber = parseInt(match[1], 10);
        }
        const code = `CMP${String(maxNumber + 1).padStart(3, '0')}`;
        samCampaign = await prisma.campaign.create({
          data: {
            code,
            name: samCampaignName,
            description: 'Leads dispatched from SAM via the Create Lead form',
            type: 'SELF',
            status: 'ACTIVE',
            dataSource: 'SAM Integration',
            // BDM owns it — see comment above. Visibility flows from ownership.
            createdById: bdm.id,
          },
          select: { id: true },
        });
        // Self-assign so the BDM also passes the assignments.some filter on
        // surfaces that use that path (some dashboards/reports check
        // assignments rather than createdById).
        await prisma.campaignAssignment.create({
          data: { userId: bdm.id, campaignId: samCampaign.id },
        });
        break;
      } catch (err) {
        if (err.code === 'P2002' && retries > 1) {
          retries--;
          continue;
        }
        throw err;
      }
    }
  }

  const leadNumber = await generateLeadNumber();
  const samCreatedAt = source.createdAt ? new Date(source.createdAt) : new Date();

  // Create CampaignData + Lead atomically. isSelfGenerated=true so the ISR
  // dashboard's existing self-lead filter excludes these (they're not ISR
  // work, same rationale as BDM_DIRECT_LEAD rows).
  const result = await prisma.$transaction(async (tx) => {
    const campaignData = await tx.campaignData.create({
      data: {
        campaignId: samCampaign.id,
        name: lead.contactName.trim(),
        company: lead.companyName.trim(),
        phone: phoneDigits,
        title: lead.designation?.trim() || '-',
        email: lead.email?.trim() || null,
        industry: lead.industry?.trim() || null,
        city: lead.city?.trim() || null,
        status: 'INTERESTED',
        assignedToId: bdm.id,
        assignedByBdmId: req.user.id,
        isSelfGenerated: true,
        createdById: req.user.id,
      },
    });

    const newLead = await tx.lead.create({
      data: {
        campaignDataId: campaignData.id,
        leadNumber,
        requirements: lead.notes?.trim() || null,
        createdById: req.user.id,
        assignedToId: bdm.id,
        status: 'NEW',
        type: 'QUALIFIED',
        creationSource: 'SAM_DISPATCH',
        // SAM-attribution — the "who created this from SAM" trail.
        samLeadId,
        samCreatedById: String(source.createdBy.id),
        samCreatedByName: source.createdBy.name || null,
        samCreatedByEmail: source.createdBy.email,
        samCreatedAt,
      },
      include: {
        campaignData: { include: { campaign: { select: { id: true, code: true, name: true } } } },
        assignedTo: { select: { id: true, name: true, email: true } },
      },
    });

    // Audit trail — entityType=LEAD, action=CREATE. userId stays null since
    // the actor is SAM (not a CRM user), but we capture the SAM operator's
    // identity in context + userName for the admin audit-log viewer.
    await tx.auditLog.create({
      data: {
        entityType: 'LEAD',
        entityId: newLead.id,
        action: 'CREATE',
        snapshot: newLead,
        context: {
          source: 'sam-dispatch',
          samLeadId,
          samCreatedByEmail: source.createdBy.email,
          assignedToBdm: bdm.name,
        },
        userId: null,
        userRole: 'SAM',
        userName: source.createdBy.name || source.createdBy.email,
        userEmail: source.createdBy.email,
      },
    });

    return newLead;
  });

  // Notify the assigned BDM so they don't have to refresh to see new work.
  createNotification(
    bdm.id,
    'LEAD_ASSIGNED',
    'New lead from SAM',
    `${source.createdBy.name || source.createdBy.email} assigned "${lead.companyName.trim()}" to you.`,
    { leadId: result.id, leadNumber: result.leadNumber, fromSam: true }
  ).catch(err => console.error('[SamLead] notify failed:', err));

  emitSidebarRefresh(bdm.id);
  emitSidebarRefreshByRole('SUPER_ADMIN');

  res.status(201).json({
    lead: {
      id: result.id,
      leadNumber: result.leadNumber,
      assignedToUserId: result.assignedToId,
      assignedToName: result.assignedTo?.name || null,
      createdAt: result.createdAt,
    },
    samLeadId,
  });
});
