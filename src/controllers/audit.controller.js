import prisma from '../config/db.js';
import { asyncHandler } from '../utils/controllerHelper.js';
import { canViewAuditLog } from '../utils/roleHelper.js';

// When a date range is ≤ this many days OR a specific actor/entity is
// filtered, we compute the exact COUNT(*). Otherwise we skip it (returning
// null) because COUNT on a forever-retained table grows unboundedly.
const NARROW_FILTER_THRESHOLD_DAYS = 30;

// GET /api/audit/events
export const listEvents = asyncHandler(async function listEvents(req, res) {
  if (!canViewAuditLog(req.user)) return res.status(403).json({ message: 'Access denied.' });

  const {
    dateFrom, dateTo, actorId, actorType, entityType, entityId, eventType,
    action, ipAddress, status, search, cursor,
  } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);

  const where = {};

  // Default view: include human-driven events (staff + customer-portal). System
  // events (cron jobs, automated maintenance) are hidden by default to keep the
  // log focused on what people did — flip the filter to see them.
  if (actorType) {
    where.actorType = actorType;
  } else {
    where.actorType = { in: ['STAFF', 'CUSTOMER'] };
  }

  if (dateFrom || dateTo) {
    where.createdAt = {};
    if (dateFrom) where.createdAt.gte = new Date(dateFrom);
    if (dateTo)   where.createdAt.lte = new Date(dateTo);
  }
  if (actorId)    where.actorId    = actorId;
  if (entityType) where.entityType = entityType;
  if (entityId)   where.entityId   = entityId;
  if (eventType)  where.eventType  = eventType;
  if (action)     where.action     = action;
  if (ipAddress)  where.ipAddress  = ipAddress;
  if (status)     where.status     = status;
  if (search && search.length >= 2) {
    where.OR = [
      { actorName:   { contains: search, mode: 'insensitive' } },
      { entityLabel: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
    ];
  }
  if (cursor) {
    where.createdAt = where.createdAt || {};
    const cursorRow = await prisma.auditEvent.findUnique({
      where: { id: cursor }, select: { createdAt: true },
    });
    if (cursorRow) where.createdAt.lt = cursorRow.createdAt;
  }

  // Approximate total: compute exact only when filters narrow the result.
  const isNarrow =
    !!actorId || !!entityId ||
    (dateFrom && dateTo && daysBetween(dateFrom, dateTo) <= NARROW_FILTER_THRESHOLD_DAYS);

  const [items, total] = await Promise.all([
    prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      select: {
        id: true, eventType: true, action: true,
        entityType: true, entityId: true, entityLabel: true,
        actorId: true, actorName: true, actorRole: true, actorType: true,
        changes: true, ipAddress: true, status: true, createdAt: true,
      },
    }),
    isNarrow ? prisma.auditEvent.count({ where }) : Promise.resolve(null),
  ]);

  const hasMore = items.length > limit;
  const trimmed = hasMore ? items.slice(0, limit) : items;
  const nextCursor = hasMore ? items[limit - 1].id : null;

  res.json({
    items: trimmed.map(toListShape),
    nextCursor,
    total,
  });
});

function daysBetween(a, b) {
  return Math.abs((new Date(b) - new Date(a)) / 86400000);
}

function toListShape(r) {
  return {
    id: r.id,
    eventType: r.eventType,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    entityLabel: r.entityLabel,
    actor: r.actorId ? {
      id: r.actorId, name: r.actorName, role: r.actorRole, type: r.actorType,
    } : null,
    changeCount: Array.isArray(r.changes) ? r.changes.length : 0,
    ipAddress: r.ipAddress,
    status: r.status,
    createdAt: r.createdAt,
  };
}

// GET /api/audit/events/:id
export const getEvent = asyncHandler(async function getEvent(req, res) {
  if (!canViewAuditLog(req.user)) return res.status(403).json({ message: 'Access denied.' });

  const row = await prisma.auditEvent.findUnique({ where: { id: req.params.id } });
  if (!row) return res.status(404).json({ message: 'Event not found.' });
  res.json({ data: row });
});

// GET /api/audit/events/filters — dropdown data for the audit log UI.
// 60s in-memory cache to absorb the natural bursty load (every page open hits this).
let FILTERS_CACHE = null;
let FILTERS_CACHED_AT = 0;
const FILTER_TTL_MS = 60_000;

export const getFilters = asyncHandler(async function getFilters(req, res) {
  if (!canViewAuditLog(req.user)) return res.status(403).json({ message: 'Access denied.' });

  if (FILTERS_CACHE && Date.now() - FILTERS_CACHED_AT < FILTER_TTL_MS) {
    return res.json({ data: FILTERS_CACHE });
  }

  const [actors, entityTypes, eventTypes] = await Promise.all([
    prisma.auditEvent.findMany({
      where: { actorId: { not: null } },
      distinct: ['actorId'],
      select: { actorId: true, actorName: true, actorRole: true },
      take: 500,
    }),
    prisma.auditEvent.findMany({
      where: { entityType: { not: null } },
      distinct: ['entityType'],
      select: { entityType: true },
      take: 100,
    }),
    prisma.auditEvent.findMany({
      distinct: ['eventType'],
      select: { eventType: true },
      take: 200,
    }),
  ]);

  FILTERS_CACHE = {
    actors:      actors.map(a => ({ id: a.actorId, name: a.actorName, role: a.actorRole })),
    entityTypes: entityTypes.map(e => e.entityType),
    eventTypes:  eventTypes.map(e => e.eventType),
  };
  FILTERS_CACHED_AT = Date.now();
  res.json({ data: FILTERS_CACHE });
});

// GET /api/audit/entity/:type/:id — timeline for one entity, desc order, capped.
export const getEntityTimeline = asyncHandler(async function getEntityTimeline(req, res) {
  if (!canViewAuditLog(req.user)) return res.status(403).json({ message: 'Access denied.' });

  const { type, id } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);

  const items = await prisma.auditEvent.findMany({
    where: { entityType: type, entityId: id },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  res.json({ data: items });
});
