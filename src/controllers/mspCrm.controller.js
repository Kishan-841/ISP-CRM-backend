/**
 * Sending a lead to the MSP CRM, from our side.
 *
 * The browser never talks to their API: the key lives in this process's
 * environment and must stay there. The frontend hits these endpoints instead.
 */
import prisma from '../config/db.js';
import { asyncHandler } from '../utils/controllerHelper.js';
import { hasAnyRole, isAdminOrTestUser } from '../utils/roleHelper.js';
import { isBdmLike } from '../utils/bdmRoles.js';
import {
  sendLeadToMsp,
  syncMspStatuses,
  isConfigured,
  buildLeadPayload,
} from '../services/mspCrm.service.js';

/** Who may hand a lead to the MSP side: the sales roles that own leads, plus admins. */
function canSend(user) {
  return (
    isBdmLike(user) ||
    isAdminOrTestUser(user) ||
    hasAnyRole(user, ['BDM_TEAM_LEADER', 'BDM_CP', 'SALES_DIRECTOR', 'ADMIN', 'SUPER_ADMIN'])
  );
}

/**
 * May this user act on THIS lead?
 *
 * Holding a sales role is not enough. Without this, any BDM could send any
 * lead by guessing an id — and because sending pushes company, contact, phone,
 * email and GST to an external system, that would be data leaving the building,
 * not merely an unauthorised read.
 *
 * Mirrors the scoping getLeads uses (lead.controller.js ~192-205): admins see
 * everything, everyone else sees leads they own or created. Team leaders are
 * deliberately NOT widened to their team here, because the regular leads
 * listing does not widen for them either — the team-oversight surfaces are
 * separate.
 *
 * @returns {{ ok: true, lead: object } | { ok: false, status: number, message: string }}
 */
async function loadAccessibleLead(user, id) {
  const lead = await prisma.lead.findUnique({
    where: { id },
    select: { id: true, assignedToId: true, createdById: true },
  });
  if (!lead) return { ok: false, status: 404, message: 'Lead not found.' };

  if (isAdminOrTestUser(user)) return { ok: true, lead };
  if (lead.assignedToId === user.id || lead.createdById === user.id) return { ok: true, lead };

  // 404 rather than 403: a 403 would confirm the lead exists to someone who
  // is not allowed to know that.
  return { ok: false, status: 404, message: 'Lead not found.' };
}

/**
 * POST /api/leads/:id/send-to-msp
 *
 * Calls their API inline so the user gets a real answer rather than a
 * fire-and-forget. A transient failure leaves the lead PENDING and the
 * 5-minute sweep picks it up, which is why that case returns 202 and not an
 * error — the lead is not lost, it is queued.
 */
export const sendLeadToMspCrm = asyncHandler(async function sendLeadToMspCrm(req, res) {
  const { id } = req.params;

  if (!canSend(req.user)) {
    return res.status(403).json({ message: 'You do not have permission to send leads to the MSP CRM.' });
  }
  if (!isConfigured()) {
    return res.status(503).json({
      message: 'MSP CRM integration is not configured on the server (MSP_CRM_API_URL / MSP_CRM_API_KEY).',
    });
  }

  // Holding a sales role is not permission to send SOMEONE ELSE'S lead to an
  // external system.
  const access = await loadAccessibleLead(req.user, id);
  if (!access.ok) return res.status(access.status).json({ message: access.message });

  const result = await sendLeadToMsp(id, req.user);

  if (result.ok) {
    return res.json({ message: result.message || 'Sent to MSP CRM.', data: result.data || null });
  }
  if (result.permanent) {
    // Their 400, a missing required field, or a dead lead — a human has to act.
    return res.status(400).json({ message: result.message });
  }
  // Transient: already queued with a backoff. Not an error from the user's view.
  return res.status(202).json({
    message: `MSP CRM is unreachable right now — the lead is queued and will retry automatically. (${result.message})`,
  });
});

/**
 * GET /api/leads/:id/msp-status
 * What we currently know, plus what we WOULD send — the preview is what makes
 * a "missing phone" rejection obvious before the user clicks send.
 */
export const getLeadMspStatus = asyncHandler(async function getLeadMspStatus(req, res) {
  const { id } = req.params;

  if (!canSend(req.user)) {
    return res.status(403).json({ message: 'You do not have permission to view MSP CRM status.' });
  }
  const access = await loadAccessibleLead(req.user, id);
  if (!access.ok) return res.status(access.status).json({ message: access.message });

  const lead = await prisma.lead.findUnique({
    where: { id },
    select: {
      id: true, leadNumber: true,
      mspSendStatus: true, mspSendAttempts: true, mspNextAttemptAt: true,
      mspLastError: true, mspSentAt: true, mspLeadId: true,
      mspStatus: true, mspStatusLabel: true, mspAssignedTo: true,
      mspOrderNo: true, mspDropReason: true, mspSyncedAt: true, mspRemovedAt: true,
      requirements: true, customerGstNo: true, billingAddress: true, bandwidthRequirement: true,
      mspSentBy: { select: { id: true, name: true } },
      campaignData: {
        select: { company: true, name: true, firstName: true, lastName: true, phone: true, email: true, state: true, city: true },
      },
    },
  });
  if (!lead) return res.status(404).json({ message: 'Lead not found.' });

  const { missing } = buildLeadPayload(lead, req.user);

  res.json({
    message: 'Success',
    data: {
      configured: isConfigured(),
      canSend: canSend(req.user),
      missingFields: missing,
      sendStatus: lead.mspSendStatus,
      sendAttempts: lead.mspSendAttempts,
      nextAttemptAt: lead.mspNextAttemptAt,
      lastError: lead.mspLastError,
      sentAt: lead.mspSentAt,
      sentBy: lead.mspSentBy?.name || null,
      mspLeadId: lead.mspLeadId,
      status: lead.mspStatus,
      statusLabel: lead.mspStatusLabel,
      assignedTo: lead.mspAssignedTo,
      orderNo: lead.mspOrderNo,
      dropReason: lead.mspDropReason,
      syncedAt: lead.mspSyncedAt,
      removedAt: lead.mspRemovedAt,
    },
  });
});

/**
 * POST /api/leads/msp/sync-now
 * Admin escape hatch — runs the same sync the cron does, for when someone
 * does not want to wait five minutes to see a status land.
 */
export const syncMspNow = asyncHandler(async function syncMspNow(req, res) {
  if (!isAdminOrTestUser(req.user)) {
    return res.status(403).json({ message: 'Admin only.' });
  }
  if (!isConfigured()) {
    return res.status(503).json({ message: 'MSP CRM integration is not configured.' });
  }
  const result = await syncMspStatuses();
  res.json({ message: result.ok ? 'Sync complete.' : `Sync incomplete: ${result.message}`, data: result });
});
