import { writeAuditEvent } from './writer.js';

/**
 * Explicit auth-event logger. Used for LOGIN and LOGOUT — neither go through
 * a Prisma CRUD path, so the audit extension can't see them.
 *
 * For successful events pass userId/userName/userRole.
 * For failed events pass status='FAILURE' + errorMessage + attemptedEmail.
 *   The attemptedEmail is rendered as the entityLabel so the audit row says
 *   e.g. "LOGIN failure · someone@example.com" even though we don't know
 *   which (if any) real user that maps to.
 */
export async function logAuthEvent({
  action, userId, userName, userRole, status, errorMessage, attemptedEmail,
}) {
  const isFailure = status === 'FAILURE';
  return writeAuditEvent({
    model:             'User',
    action,
    after:             userId ? { id: userId, name: userName, email: null } : null,
    eventTypeOverride: `user.${action.toLowerCase()}`,
    status:            status || 'SUCCESS',
    errorMessage:      errorMessage || null,
    description:       isFailure && attemptedEmail ? `Attempted email: ${attemptedEmail}` : null,
  });
}
