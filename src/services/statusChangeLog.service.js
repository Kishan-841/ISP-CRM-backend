import prisma from '../config/db.js';

/**
 * Log a status field change for audit purposes.
 * Silently catches errors so audit logging never breaks the main operation.
 *
 * @param {Object} params
 * @param {string} params.entityType - "LEAD", "INVOICE", "DELIVERY_REQUEST", "VENDOR"
 * @param {string} params.entityId - UUID of the entity
 * @param {string} params.field - Field that changed (e.g. "status", "opsApprovalStatus")
 * @param {string|null} params.oldValue - Previous value (null for initial creation)
 * @param {string} params.newValue - New value
 * @param {string} params.changedById - UUID of the user who made the change
 * @param {string|null} [params.reason] - Optional reason for the change
 * @returns {Promise<Object|null>} The created log entry, or null on no-op/error
 */
export async function logStatusChange({ entityType, entityId, field, oldValue, newValue, changedById, reason = null }) {
  try {
    if (oldValue === newValue) return null;

    return await prisma.statusChangeLog.create({
      data: {
        entityType,
        entityId,
        field,
        oldValue: oldValue?.toString() || null,
        newValue: newValue.toString(),
        changedById,
        reason,
      },
    });
  } catch (error) {
    console.error('Failed to log status change:', error);
    return null;
  }
}

/**
 * Retrieve the full status change history for a given entity,
 * ordered most-recent-first.
 *
 * @param {string} entityType - "LEAD", "INVOICE", etc.
 * @param {string} entityId - UUID of the entity
 * @returns {Promise<Object[]>} Array of status change log entries with changedBy user info
 */
export async function getStatusHistory(entityType, entityId) {
  return await prisma.statusChangeLog.findMany({
    where: { entityType, entityId },
    orderBy: { changedAt: 'desc' },
    include: { changedBy: { select: { id: true, name: true, role: true } } },
  });
}
