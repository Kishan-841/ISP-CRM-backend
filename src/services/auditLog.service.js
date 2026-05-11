import prisma from '../config/db.js';

// Unified audit log for the lead pipeline. See AuditLog in schema.prisma.
//
// Two write modes:
//   1. logAudit({ ... }) — fully-formed call; use directly when you have
//      a single before/after to log.
//   2. captureUpdate(...) helpers — pre-computed diff helpers for the
//      common case of "fetch row → mutate → log if anything changed".
//
// Never throws. If the audit write fails the main operation must still
// succeed — losing an audit entry is bad but blocking a customer
// activation because the audit table is full is worse.

const ENTITY_TYPES = new Set(['LEAD', 'CAMPAIGN', 'CAMPAIGN_DATA']);
const ACTIONS = new Set(['CREATE', 'UPDATE', 'DELETE']);

// Fields that change on virtually every write but carry no real audit
// value. Exclude them from the diff so the changes JSON stays focused on
// what humans actually touched.
const DEFAULT_IGNORE_FIELDS = new Set([
  'updatedAt',
  'lastEditedAt',
  'lastEditedById',
]);

// Normalize a value for equality comparison. Dates become their ISO
// string; objects get JSON-stringified so deep equality works without
// requiring a recursive walk.
function normalizeForCompare(v) {
  if (v == null) return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

// Build a { field: { from, to } } diff between two row snapshots.
// Pass extra ignore fields per call when a controller knows certain
// fields are noise (e.g. recomputed totals that depend on the change).
export function diffObjects(before, after, extraIgnore = []) {
  const changes = {};
  const ignore = new Set([...DEFAULT_IGNORE_FIELDS, ...extraIgnore]);
  const allKeys = new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {}),
  ]);
  for (const key of allKeys) {
    if (ignore.has(key)) continue;
    const oldV = before?.[key];
    const newV = after?.[key];
    if (normalizeForCompare(oldV) !== normalizeForCompare(newV)) {
      changes[key] = { from: oldV ?? null, to: newV ?? null };
    }
  }
  return changes;
}

// Core writer. Swallows all errors and logs them so the audit hook can
// never break a request. user is { id, role, name, email } — typically
// req.user from auth middleware.
export async function logAudit({
  entityType,
  entityId,
  action,
  changes,
  snapshot,
  context,
  user,
}) {
  if (!ENTITY_TYPES.has(entityType) || !ACTIONS.has(action)) {
    console.warn('[AuditLog] invalid entityType/action', { entityType, action });
    return;
  }
  if (!entityId) {
    console.warn('[AuditLog] missing entityId', { entityType, action });
    return;
  }
  try {
    await prisma.auditLog.create({
      data: {
        entityType,
        entityId,
        action,
        changes: changes && Object.keys(changes).length ? changes : null,
        snapshot: snapshot || null,
        context: context || null,
        userId: user?.id || null,
        userRole: user?.role || null,
        userName: user?.name || null,
        userEmail: user?.email || null,
      },
    });
  } catch (err) {
    console.error('[AuditLog] write failed:', err?.message || err);
  }
}

// Convenience: log a Lead update by diffing before/after snapshots.
// Skips silently when no fields actually changed.
export async function logLeadUpdate({ leadId, before, after, user, context = null, extraIgnore = [] }) {
  const changes = diffObjects(before, after, extraIgnore);
  if (Object.keys(changes).length === 0) return;
  return logAudit({
    entityType: 'LEAD',
    entityId: leadId,
    action: 'UPDATE',
    changes,
    context,
    user,
  });
}

// Convenience: log a CampaignData update.
export async function logCampaignDataUpdate({ campaignDataId, before, after, user, context = null, extraIgnore = [] }) {
  const changes = diffObjects(before, after, extraIgnore);
  if (Object.keys(changes).length === 0) return;
  return logAudit({
    entityType: 'CAMPAIGN_DATA',
    entityId: campaignDataId,
    action: 'UPDATE',
    changes,
    context,
    user,
  });
}

// Convenience: log a delete with a full snapshot of the row that's
// about to disappear. Take the snapshot BEFORE the actual delete call.
export async function logDelete({ entityType, entityId, snapshot, user, context = null }) {
  return logAudit({
    entityType,
    entityId,
    action: 'DELETE',
    snapshot,
    context,
    user,
  });
}
