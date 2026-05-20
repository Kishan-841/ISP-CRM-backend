import prisma from '../config/db.js';
import { isAdmin } from '../utils/roleHelper.js';
import { asyncHandler, parsePagination } from '../utils/controllerHelper.js';
import {
  enqueueCommercialChangeStatusChangedWebhook,
  attemptDeliveryInBackground,
} from '../services/samWebhook.service.js';
import { generateServiceOrderNumber } from '../services/documentNumber.service.js';
import { emitSidebarRefreshByRole } from '../sockets/index.js';

// Quick-disconnect inbox surface — list / detail / decide. Inbound creation
// happens in samWebhookInbound.controller.js. This file owns everything an
// admin does to a CommercialChange row after SAM raises it.

// Snapshot the lead's "current" state for inbox display. We pull from the
// live Lead so the operator sees the up-to-date ARC / plan even if some
// ServiceOrder altered things between request and review. The request-time
// snapshot lives on the CommercialChange row for history/audit fidelity.
const LEAD_SUMMARY_SELECT = {
  id: true,
  leadNumber: true,
  customerUsername: true,
  arcAmount: true,
  actualPlanName: true,
  actualPlanBandwidth: true,
  campaignData: { select: { company: true, name: true, email: true, phone: true } },
};

// GET /api/commercial-changes/queue?status=PENDING&page=&limit=&search=
//
// Default status=PENDING. Search hits company / contact name / SAM raiser
// email — enough to find a specific row without a separate filter UI.
export const getQueue = asyncHandler(async function getQueue(req, res) {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const { page, limit, skip } = parsePagination(req.query, 20);
  const status = (req.query.status || 'PENDING').toUpperCase();
  if (!['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
    return res.status(400).json({ message: 'Invalid status filter.' });
  }
  const search = (req.query.search || '').trim();

  const where = { status };
  if (search) {
    where.OR = [
      { raisedBySamEmail: { contains: search, mode: 'insensitive' } },
      { reason: { contains: search, mode: 'insensitive' } },
      { lead: { campaignData: { company: { contains: search, mode: 'insensitive' } } } },
      { lead: { campaignData: { name: { contains: search, mode: 'insensitive' } } } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.commercialChange.findMany({
      where,
      orderBy: status === 'PENDING' ? { createdAt: 'asc' } : { decidedAt: 'desc' },
      skip,
      take: limit,
      include: {
        lead: { select: LEAD_SUMMARY_SELECT },
        decidedBy: { select: { id: true, name: true, email: true } },
        serviceOrder: { select: { id: true, orderNumber: true, status: true } },
      },
    }),
    prisma.commercialChange.count({ where }),
  ]);

  res.json({
    items,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  });
});

// GET /api/commercial-changes/sidebar-counts — { pending } for badge
export const getSidebarCounts = asyncHandler(async function getSidebarCounts(req, res) {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ message: 'Access denied.' });
  }
  const pending = await prisma.commercialChange.count({ where: { status: 'PENDING' } });
  res.json({ pending });
});

// GET /api/commercial-changes/:id — detail view. Joins SamWebhookLog by the
// stored outboundLogId so the UI can show "decision delivered to SAM" status.
export const getById = asyncHandler(async function getById(req, res) {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ message: 'Access denied.' });
  }
  const row = await prisma.commercialChange.findUnique({
    where: { id: req.params.id },
    include: {
      lead: { select: LEAD_SUMMARY_SELECT },
      decidedBy: { select: { id: true, name: true, email: true } },
      // Follow-on ServiceOrder (created by SAM via POST /service-orders after
      // admin approves). The UI uses this to deep-link into the workflow queue.
      serviceOrder: {
        select: { id: true, orderNumber: true, status: true, orderType: true, createdAt: true },
      },
    },
  });
  if (!row) return res.status(404).json({ message: 'Not found.' });

  let outbound = null;
  if (row.outboundLogId) {
    outbound = await prisma.samWebhookLog.findUnique({
      where: { id: row.outboundLogId },
      select: {
        id: true,
        eventId: true,
        status: true,
        attemptCount: true,
        lastAttemptedAt: true,
        lastResponseStatus: true,
        nextAttemptAt: true,
      },
    });
  }

  res.json({ ...row, outbound });
});

// PATCH /api/commercial-changes/:id/decide — body { decision, note? }
//
// APPROVE path: flip CC to APPROVED, auto-create a DISCONNECTION ServiceOrder
// at PENDING_DOCS_REVIEW (spec §1 stage 2 — admin approval IS the
// Sales-Director gate for QUICK orders, so we skip PENDING_SALES_DIRECTOR_APPROVAL),
// link CC ↔ SO, fire commercialChange.statusChanged { toStatus: 'PENDING_DOCS_REVIEW' }.
//
// REJECT path: flip CC to REJECTED, fire commercialChange.statusChanged
// { toStatus: 'REJECTED' }. No SO is created.
//
// Everything (CC update, SO create, audit log, webhook enqueue) commits in
// one transaction; the immediate post-commit delivery attempt fires in
// background and falls back to the retry cron on 5xx/network.
export const decide = asyncHandler(async function decide(req, res) {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ message: 'Access denied.' });
  }

  const { id } = req.params;
  const { decision, note } = req.body || {};

  if (!['APPROVE', 'REJECT'].includes(decision)) {
    return res.status(400).json({ message: 'decision must be APPROVE or REJECT.' });
  }
  const trimmedNote = typeof note === 'string' ? note.trim() : '';
  if (decision === 'REJECT' && trimmedNote.length < 3) {
    return res.status(400).json({ message: 'A note (min 3 chars) is required when rejecting.' });
  }

  const existing = await prisma.commercialChange.findUnique({
    where: { id },
    include: { lead: { select: { id: true, customerUserId: true, actualPlanName: true, actualPlanBandwidth: true, actualPlanPrice: true, arcAmount: true, campaignData: { select: { company: true } } } } },
  });
  if (!existing) return res.status(404).json({ message: 'Not found.' });
  if (existing.status !== 'PENDING') {
    return res.status(409).json({ message: `Already ${existing.status.toLowerCase()}.` });
  }
  if (decision === 'APPROVE') {
    if (!existing.disconnectionCategoryId || !existing.disconnectionSubCategoryId) {
      return res.status(400).json({
        message: 'CommercialChange is missing disconnection category — cannot auto-create service order. SAM must include disconnectionCategoryId/SubCategoryId on the QUICK request payload.',
      });
    }
    if (!existing.lead?.customerUserId) {
      return res.status(400).json({ message: 'Lead has no active customer account — cannot create a service order.' });
    }
  }

  const newStatus = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  const toStatus = decision === 'APPROVE' ? 'PENDING_DOCS_REVIEW' : 'REJECTED';
  const decidedAt = new Date();

  // Pre-generate the SO number outside the transaction — generator uses
  // its own atomic upsert and we don't want to nest serialization conflicts.
  let preparedServiceOrder = null;
  if (decision === 'APPROVE') {
    const orderNumber = await generateServiceOrderNumber();
    preparedServiceOrder = {
      orderNumber,
      // QUICK marker baked into notes so every approver page (docs, NOC,
      // accounts) sees the provenance via the inline notes column.
      notes: `SAM-${(existing.commercialChangeId || '').slice(0, 8)} | QUICK disconnect — CRM Admin approved | Reason: ${existing.reason}`,
    };
  }

  const { updatedRow, serviceOrder, webhookLog } = await prisma.$transaction(async (tx) => {
    const row = await tx.commercialChange.update({
      where: { id },
      data: {
        status: newStatus,
        decidedById: req.user.id,
        decidedAt,
        decisionNote: trimmedNote || null,
      },
    });

    await tx.auditLog.create({
      data: {
        entityType: 'COMMERCIAL_CHANGE',
        entityId: id,
        action: 'UPDATE',
        changes: {
          status: { from: 'PENDING', to: newStatus },
          ...(trimmedNote ? { decisionNote: { from: null, to: trimmedNote } } : {}),
        },
        snapshot: row,
        context: { decision, commercialChangeId: row.commercialChangeId },
        userId: req.user.id,
        userRole: req.user.role,
        userName: req.user.name,
        userEmail: req.user.email,
      },
    });

    // On APPROVE — create the follow-on ServiceOrder and link it. We start
    // at PENDING_DOCS_REVIEW (not PENDING_SALES_DIRECTOR_APPROVAL like
    // a normal disconnect) because the CRM admin's approval here is the
    // equivalent gate for QUICK orders.
    let so = null;
    if (decision === 'APPROVE') {
      so = await tx.serviceOrder.create({
        data: {
          orderNumber: preparedServiceOrder.orderNumber,
          customerId: existing.leadId,
          orderType: 'DISCONNECTION',
          status: 'PENDING_DOCS_REVIEW',
          createdById: req.user.id,
          currentPlanName: existing.lead?.actualPlanName ?? null,
          currentBandwidth: existing.lead?.actualPlanBandwidth ?? null,
          currentArc: existing.lead?.arcAmount ?? existing.lead?.actualPlanPrice ?? null,
          disconnectionCategoryId: existing.disconnectionCategoryId,
          disconnectionSubCategoryId: existing.disconnectionSubCategoryId,
          disconnectionReason: existing.reason,
          disconnectionDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          notes: preparedServiceOrder.notes,
        },
      });
      await tx.commercialChange.update({
        where: { id },
        data: { serviceOrderId: so.id },
      });
    }

    const log = await enqueueCommercialChangeStatusChangedWebhook(tx, {
      change: row,
      fromStatus: 'PENDING_ADMIN_APPROVAL',
      toStatus,
      changedByUser: req.user,
      note: trimmedNote || undefined,
      serviceOrder: so,
    });

    if (log) {
      await tx.commercialChange.update({
        where: { id },
        data: { outboundEventId: log.eventId, outboundLogId: log.id },
      });
    }

    return { updatedRow: row, serviceOrder: so, webhookLog: log };
  });

  if (webhookLog) {
    attemptDeliveryInBackground(webhookLog.id);
  }
  emitSidebarRefreshByRole('SUPER_ADMIN');
  // If a SO was created, notify the docs team (their queue just got a new row).
  if (serviceOrder) {
    emitSidebarRefreshByRole('DOCS_TEAM');
  }

  res.json({
    success: true,
    message: decision === 'APPROVE' ? 'Approved — workflow ticket created.' : 'Rejected.',
    item: updatedRow,
    serviceOrder: serviceOrder ? { id: serviceOrder.id, orderNumber: serviceOrder.orderNumber, status: serviceOrder.status } : null,
    outboundEnqueued: Boolean(webhookLog),
  });
});

// PATCH /api/commercial-changes/:id/cancel — admin abandons an in-flight QD
// after they've already approved it. Marks CC = CANCELLED, the linked SO =
// CANCELLED, and fires commercialChange.statusChanged { toStatus: 'CANCELLED' }
// so SAM reverts the account to ACTIVE on their side.
//
// Disallowed when the SO has already reached COMPLETED (can't un-disconnect
// a customer through the cancel button — they'd need an upgrade/new lead).
export const cancel = asyncHandler(async function cancel(req, res) {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ message: 'Access denied.' });
  }
  const { id } = req.params;
  const { note } = req.body || {};
  const trimmedNote = typeof note === 'string' ? note.trim() : '';
  if (trimmedNote.length < 3) {
    return res.status(400).json({ message: 'A note (min 3 chars) is required when cancelling.' });
  }

  const existing = await prisma.commercialChange.findUnique({
    where: { id },
    include: { serviceOrder: { select: { id: true, orderNumber: true, status: true } } },
  });
  if (!existing) return res.status(404).json({ message: 'Not found.' });
  if (existing.status !== 'APPROVED') {
    return res.status(409).json({ message: `Cannot cancel a ${existing.status.toLowerCase()} request.` });
  }
  if (existing.serviceOrder?.status === 'COMPLETED') {
    return res.status(409).json({ message: 'Service order already completed — cannot cancel.' });
  }

  const { updatedRow, webhookLog } = await prisma.$transaction(async (tx) => {
    const row = await tx.commercialChange.update({
      where: { id },
      data: { status: 'CANCELLED', decisionNote: trimmedNote },
    });

    let priorSoStatus = null;
    if (existing.serviceOrder?.id) {
      priorSoStatus = existing.serviceOrder.status;
      await tx.serviceOrder.update({
        where: { id: existing.serviceOrder.id },
        data: { status: 'CANCELLED', updatedAt: new Date() },
      });
    }

    await tx.auditLog.create({
      data: {
        entityType: 'COMMERCIAL_CHANGE',
        entityId: id,
        action: 'UPDATE',
        changes: { status: { from: 'APPROVED', to: 'CANCELLED' }, decisionNote: { from: existing.decisionNote, to: trimmedNote } },
        snapshot: row,
        context: {
          commercialChangeId: row.commercialChangeId,
          cancelledServiceOrderId: existing.serviceOrder?.id || null,
          cancelledFromStatus: priorSoStatus,
        },
        userId: req.user.id,
        userRole: req.user.role,
        userName: req.user.name,
        userEmail: req.user.email,
      },
    });

    const log = await enqueueCommercialChangeStatusChangedWebhook(tx, {
      change: row,
      fromStatus: priorSoStatus || 'APPROVED',
      toStatus: 'CANCELLED',
      changedByUser: req.user,
      note: trimmedNote,
      serviceOrder: existing.serviceOrder?.id ? existing.serviceOrder : null,
    });

    if (log) {
      await tx.commercialChange.update({
        where: { id },
        data: { outboundEventId: log.eventId, outboundLogId: log.id },
      });
    }

    return { updatedRow: row, webhookLog: log };
  });

  if (webhookLog) attemptDeliveryInBackground(webhookLog.id);
  emitSidebarRefreshByRole('SUPER_ADMIN');
  emitSidebarRefreshByRole('DOCS_TEAM');
  emitSidebarRefreshByRole('NOC');
  emitSidebarRefreshByRole('ACCOUNTS_TEAM');

  res.json({ success: true, message: 'Cancelled.', item: updatedRow });
});
