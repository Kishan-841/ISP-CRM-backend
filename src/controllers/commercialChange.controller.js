import prisma from '../config/db.js';
import { isAdmin } from '../utils/roleHelper.js';
import { asyncHandler, parsePagination } from '../utils/controllerHelper.js';
import {
  enqueueQuickDisconnectDecidedWebhook,
  attemptDeliveryInBackground,
} from '../services/samWebhook.service.js';
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
// Single transaction: update row, write AuditLog, enqueue outbound webhook,
// store the eventId+logId on the row. After commit the immediate post-commit
// delivery attempt fires in background; if it 5xx's or times out, the retry
// cron picks it up.
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

  const existing = await prisma.commercialChange.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ message: 'Not found.' });
  if (existing.status !== 'PENDING') {
    return res.status(409).json({ message: `Already ${existing.status.toLowerCase()}.` });
  }

  const newStatus = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  const decidedAt = new Date();

  const { updatedRow, webhookLog } = await prisma.$transaction(async (tx) => {
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

    const log = await enqueueQuickDisconnectDecidedWebhook(
      tx,
      row,
      req.user,
      decision,
      trimmedNote || undefined,
    );

    if (log) {
      await tx.commercialChange.update({
        where: { id },
        data: { outboundEventId: log.eventId, outboundLogId: log.id },
      });
    }

    return { updatedRow: row, webhookLog: log };
  });

  if (webhookLog) {
    attemptDeliveryInBackground(webhookLog.id);
  }
  emitSidebarRefreshByRole('SUPER_ADMIN');

  res.json({
    success: true,
    message: decision === 'APPROVE' ? 'Approved.' : 'Rejected.',
    item: updatedRow,
    outboundEnqueued: Boolean(webhookLog),
  });
});
