import prisma from '../config/db.js';
import { auditContext } from './context.js';
import { toEventType } from './eventTypes.js';
import { entityLabelFor } from './auditedModels.js';
import { computeDiff } from './diff.js';

/**
 * Single entry point for writing audit rows. Reads per-request context from
 * AsyncLocalStorage; merges with the caller-supplied payload; inserts one
 * row into audit_events. Never throws — failures go to console.error with
 * the full intended payload so a missing row can be reconstructed from
 * container logs.
 *
 * Payload shape:
 *   {
 *     model,             // Prisma model name, e.g. 'Lead' (omit for login/logout)
 *     action,            // 'CREATE' | 'UPDATE' | 'DELETE' | 'LOGIN' | 'LOGOUT'
 *     before,            // record snapshot before mutation (UPDATE/DELETE)
 *     after,             // record snapshot after mutation (CREATE/UPDATE)
 *     description,       // optional human summary
 *     reason,            // optional user-supplied "why"
 *     status,            // 'SUCCESS' (default) | 'FAILURE'
 *     errorMessage,      // when status=FAILURE
 *     eventTypeOverride, // explicit event type (e.g. 'user.login') — overrides
 *                        //   the (model, action) -> slug mapping
 *   }
 *
 * For UPDATE: pass both `before` and `after`. We compute the diff; if the
 * diff is empty (no real changes), we skip the write entirely and return null.
 * For CREATE: pass only `after`.
 * For DELETE: pass only `before`.
 * For LOGIN/LOGOUT: omit `model` (or set it to 'User') and pass `eventTypeOverride`.
 */
export async function writeAuditEvent(payload) {
  const ctx = auditContext.getStore() || {};

  const action = payload.action;
  const record = payload.after ?? payload.before ?? null;

  let changes = null;
  if (action === 'UPDATE' && payload.before && payload.after) {
    changes = computeDiff(payload.before, payload.after);
    if (changes.length === 0) return null; // no-op update: don't write a row
  }

  const row = {
    eventType:     payload.eventTypeOverride || toEventType(payload.model || 'User', action),
    action,
    entityType:    payload.model || null,
    entityId:      record?.id || null,
    entityLabel:   payload.model ? entityLabelFor(payload.model, record) : null,

    actorId:       ctx.actorId   ?? null,
    actorName:     ctx.actorName ?? null,
    actorRole:     ctx.actorRole ?? null,
    actorType:     ctx.actorType ?? 'SYSTEM',

    changes,
    description:   payload.description || null,
    reason:        payload.reason      || null,

    ipAddress:     ctx.ipAddress  ?? null,
    userAgent:     ctx.userAgent  ?? null,
    requestId:     ctx.requestId  ?? null,
    routePath:     ctx.routePath  ?? null,
    httpMethod:    ctx.httpMethod ?? null,

    status:        payload.status       || 'SUCCESS',
    errorMessage:  payload.errorMessage || null,
  };

  try {
    return await prisma.auditEvent.create({ data: row });
  } catch (err) {
    console.error('[AUDIT] write failed:', err?.message || err);
    console.error('[AUDIT] intended payload:', JSON.stringify(row));
    return null;
  }
}
