import prisma from '../config/db.js';
import { attemptDelivery, resyncActivations } from '../services/samWebhook.service.js';

// Dev/admin endpoints for the SAM webhook outbox. Behind staff auth +
// SUPER_ADMIN. Mainly used to (a) inspect what the cron is sweeping and
// (b) manually re-fire a row to confirm SAM-side idempotency end-to-end
// without faking eventIds in psql.

export const replaySamWebhook = async (req, res) => {
  const { id } = req.params;
  const existing = await prisma.samWebhookLog.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ message: 'SamWebhookLog row not found.' });
  }

  // attemptDelivery is a no-op on rows that aren't PENDING (e.g. already
  // DELIVERED or FAILED). To support replaying a DELIVERED row through
  // SAM's idempotency check, flip it back to PENDING for one shot. This
  // is intentional — we want to prove the duplicate path.
  if (existing.status !== 'PENDING') {
    await prisma.samWebhookLog.update({
      where: { id },
      data: { status: 'PENDING', nextAttemptAt: new Date() },
    });
  }

  await attemptDelivery(id);

  const row = await prisma.samWebhookLog.findUnique({ where: { id } });
  res.json(row);
};

// Backfill the extra customer fields (lead number, username, address, city,
// GST, industry, IP details) onto customers SAM already holds. Each target
// gets a brand-new customer.activated event built from today's lead data —
// replaying the stored payload would only hit SAM's dedup and change nothing.
//
// Returns as soon as the outbox rows exist; the retry cron delivers them at
// 50/minute. Watch progress with GET /api/admin/sam-webhook?status=PENDING.
export const resyncSamCustomers = async (req, res) => {
  const { leadIds, includeNeverSent, limit } = req.body || {};

  if (leadIds !== undefined && !Array.isArray(leadIds)) {
    return res.status(400).json({ message: 'leadIds must be an array of lead ids.' });
  }

  const result = await resyncActivations({
    leadIds: leadIds || null,
    includeNeverSent: includeNeverSent === true,
    limit: Number(limit) || 500,
  });

  if (!result.configured) {
    return res.status(503).json({
      message: 'SAM_WEBHOOK_URL / SAM_WEBHOOK_SECRET are not set on this server.',
    });
  }

  res.json({
    message: `Queued ${result.enqueued} customer(s) for redelivery to SAM. The retry job sends them within a few minutes.`,
    ...result,
  });
};

export const listSamWebhooks = async (req, res) => {
  const { status, leadId, limit } = req.query;
  const take = Math.min(Number(limit) || 50, 200);
  const where = {};
  if (status) where.status = status;
  if (leadId) where.leadId = leadId;

  const rows = await prisma.samWebhookLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take,
  });
  res.json({ items: rows });
};

// Audit log viewer for admin / master / sales-director. Paginated and
// filterable on entity type / action / user / date range / entity id.
// Search hits userName / userEmail substrings — enough for "show me
// every change Fahim made" without indexing free text.
export const listAuditLog = async (req, res) => {
  const {
    entityType,
    entityId,
    action,
    userId,
    fromDate,
    toDate,
    search,
    page: pageRaw = '1',
    limit: limitRaw = '50',
  } = req.query;

  const page = Math.max(1, parseInt(pageRaw, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(limitRaw, 10) || 50));
  const skip = (page - 1) * limit;

  const where = {};
  if (entityType) where.entityType = entityType;
  if (entityId) where.entityId = entityId;
  if (action) where.action = action;
  if (userId) where.userId = userId;
  if (fromDate || toDate) {
    where.createdAt = {};
    if (fromDate) where.createdAt.gte = new Date(fromDate);
    if (toDate) {
      const end = new Date(toDate);
      end.setHours(23, 59, 59, 999);
      where.createdAt.lte = end;
    }
  }
  if (search && search.trim()) {
    const term = search.trim();
    where.OR = [
      { userName: { contains: term, mode: 'insensitive' } },
      { userEmail: { contains: term, mode: 'insensitive' } },
      { entityId: { contains: term, mode: 'insensitive' } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.auditLog.count({ where }),
  ]);

  res.json({
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  });
};

// List of distinct user names that appear in the audit log, sorted —
// powers the "Who" filter dropdown without loading a separate users
// API. Cheap because of the userId index.
export const listAuditLogActors = async (req, res) => {
  const rows = await prisma.auditLog.findMany({
    where: { userId: { not: null } },
    distinct: ['userId'],
    select: { userId: true, userName: true, userEmail: true, userRole: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json({ items: rows.filter(r => r.userId) });
};
