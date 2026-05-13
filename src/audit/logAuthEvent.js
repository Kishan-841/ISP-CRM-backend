import { writeAuditEvent } from './writer.js';

/**
 * Explicit auth-event logger. Used for LOGIN and LOGOUT which don't go
 * through a Prisma CRUD path and so aren't seen by the audit extension.
 *
 * Caller passes the user's identity; context (IP, UA, request id, etc.)
 * is read from ALS by writeAuditEvent. For login itself, the caller
 * usually wraps the call in auditContext.run(...) because login runs
 * BEFORE any auth middleware has populated the scope.
 */
export async function logAuthEvent({ action, userId, userName, userRole, status, errorMessage }) {
  return writeAuditEvent({
    model: 'User',
    action,                            // 'LOGIN' or 'LOGOUT'
    after: userId ? { id: userId, name: userName, email: null } : null,
    eventTypeOverride: `user.${action.toLowerCase()}`,
    status: status || 'SUCCESS',
    errorMessage: errorMessage || null,
  });
}
