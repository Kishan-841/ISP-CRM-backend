import prisma from '../src/config/db.js';

console.log('Starting audit backfill (StatusChangeLog + AuditLog → AuditEvent)…');

const BATCH = 500;

// Map source-system entityType strings to the new free-form entityType the
// new system uses. The new system uses Prisma model names directly
// (PascalCase). Source systems used enum-style upper-snake-case strings.
const ENTITY_TYPE_MAP = {
  LEAD:             'Lead',
  INVOICE:          'Invoice',
  DELIVERY_REQUEST: 'DeliveryRequest',
  VENDOR:           'Vendor',
  CAMPAIGN:         'Campaign',
  CAMPAIGN_DATA:    'CampaignData',
};

function mapEntityType(source) {
  return ENTITY_TYPE_MAP[source] || source;
}

function eventTypeSlug(modelName, action) {
  const slug = modelName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  return `${slug}.${action.toLowerCase()}`;
}

// Convert AuditLog's `{ field: { from, to } }` shape into the new
// `[{ field, oldValue, newValue }]` array shape.
function normalizeAuditLogChanges(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return null;
  const out = [];
  for (const [field, value] of Object.entries(changes)) {
    if (value && typeof value === 'object' && 'from' in value && 'to' in value) {
      out.push({ field, oldValue: value.from, newValue: value.to });
    } else {
      // Defensive — if the row was written in some non-standard shape, keep it.
      out.push({ field, oldValue: null, newValue: value });
    }
  }
  return out.length > 0 ? out : null;
}

// ─────────────────────────────────────────────────────────────────────────
// Backfill StatusChangeLog → AuditEvent
// ─────────────────────────────────────────────────────────────────────────

async function backfillStatusChangeLogs() {
  let cursor = null;
  let total = 0;
  let inserted = 0;
  let skipped = 0;

  while (true) {
    const rows = await prisma.statusChangeLog.findMany({
      where: cursor ? { id: { gt: cursor } } : undefined,
      orderBy: { id: 'asc' },
      take: BATCH,
      include: { changedBy: { select: { id: true, name: true, role: true } } },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    total += rows.length;

    for (const row of rows) {
      const modelName = mapEntityType(row.entityType);
      // Idempotency: skip if an audit row already exists for the same field
      // change at (approximately) the same instant. Multiple StatusChangeLog
      // rows can share a changedAt — when our backfill writes them, each
      // becomes a separate AuditEvent. To detect duplicates we need to check
      // ALL AuditEvents at that timestamp, not just findFirst.
      const candidates = await prisma.auditEvent.findMany({
        where: {
          entityType: modelName,
          entityId: row.entityId,
          action: 'UPDATE',
          createdAt: row.changedAt,
        },
        select: { id: true, changes: true },
      });

      const isDuplicate = candidates.some(c =>
        Array.isArray(c.changes) && c.changes.some(ch => ch.field === row.field)
      );
      if (isDuplicate) { skipped++; continue; }

      await prisma.auditEvent.create({
        data: {
          eventType: eventTypeSlug(modelName, 'UPDATE'),
          action: 'UPDATE',
          entityType: modelName,
          entityId: row.entityId,
          entityLabel: null, // historical rows lacked label snapshot
          actorId: row.changedById,
          actorName: row.changedBy?.name || null,
          actorRole: row.changedBy?.role || null,
          actorType: row.changedById ? 'STAFF' : 'SYSTEM',
          changes: [{ field: row.field, oldValue: row.oldValue, newValue: row.newValue }],
          reason: row.reason,
          status: 'SUCCESS',
          schemaVersion: 1,
          createdAt: row.changedAt,
        },
      });
      inserted++;
    }

    if (total % 2000 === 0) {
      console.log(`  StatusChangeLog: processed ${total}, inserted ${inserted}, skipped ${skipped}`);
    }
  }

  console.log(`  StatusChangeLog DONE. processed ${total}, inserted ${inserted}, skipped ${skipped}`);
  return { total, inserted, skipped };
}

// ─────────────────────────────────────────────────────────────────────────
// Backfill AuditLog → AuditEvent
// ─────────────────────────────────────────────────────────────────────────

async function backfillAuditLogs() {
  let cursor = null;
  let total = 0;
  let inserted = 0;
  let skipped = 0;

  while (true) {
    const rows = await prisma.auditLog.findMany({
      where: cursor ? { id: { gt: cursor } } : undefined,
      orderBy: { id: 'asc' },
      take: BATCH,
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    total += rows.length;

    for (const row of rows) {
      const modelName = mapEntityType(row.entityType);
      // Idempotency: an AuditLog row maps to exactly one AuditEvent row by
      // (entityType, entityId, action, createdAt).
      const exists = await prisma.auditEvent.findFirst({
        where: {
          entityType: modelName,
          entityId: row.entityId,
          action: row.action,
          createdAt: row.createdAt,
        },
        select: { id: true },
      });
      if (exists) { skipped++; continue; }

      const changes = row.action === 'UPDATE' ? normalizeAuditLogChanges(row.changes) : null;

      await prisma.auditEvent.create({
        data: {
          eventType: eventTypeSlug(modelName, row.action),
          action: row.action,
          entityType: modelName,
          entityId: row.entityId,
          entityLabel: null,
          actorId: row.userId,
          actorName: row.userName,
          actorRole: row.userRole,
          actorType: row.userId ? 'STAFF' : 'SYSTEM',
          changes,
          // Preserve the AuditLog's snapshot + context as JSON-encoded
          // strings in `description` so they're not lost. (We could
          // extend AuditEvent schema with these fields, but for now we
          // keep the data accessible without a schema change.)
          description: row.snapshot || row.context
            ? JSON.stringify({ snapshot: row.snapshot || null, context: row.context || null })
            : null,
          status: 'SUCCESS',
          schemaVersion: 1,
          createdAt: row.createdAt,
        },
      });
      inserted++;
    }

    if (total % 2000 === 0) {
      console.log(`  AuditLog: processed ${total}, inserted ${inserted}, skipped ${skipped}`);
    }
  }

  console.log(`  AuditLog DONE. processed ${total}, inserted ${inserted}, skipped ${skipped}`);
  return { total, inserted, skipped };
}

// ─────────────────────────────────────────────────────────────────────────

try {
  const a = await backfillStatusChangeLogs();
  const b = await backfillAuditLogs();
  console.log('');
  console.log('Backfill complete.');
  console.log(`  StatusChangeLog: ${a.inserted} inserted, ${a.skipped} skipped (already migrated)`);
  console.log(`  AuditLog:        ${b.inserted} inserted, ${b.skipped} skipped (already migrated)`);
  console.log(`  Total new audit_events rows: ${a.inserted + b.inserted}`);
} finally {
  await prisma.$disconnect();
}
