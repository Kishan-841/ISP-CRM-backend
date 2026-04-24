/**
 * Role Helper Utility
 * Helper functions for role-based access control
 */

/**
 * Check if user is SUPER_ADMIN or MASTER (has full access)
 */
export const isAdmin = (user) => {
  return user?.role === 'SUPER_ADMIN' || user?.role === 'MASTER' || user?.role === 'SALES_DIRECTOR';
};

// Alias for backward compatibility
export const isAdminOrTestUser = isAdmin;

/**
 * Stricter check for destructive / non-reversible operations
 * (permanent lead delete, invoice delete, etc.).
 *
 * SALES_DIRECTOR has view-level parity with SUPER_ADMIN elsewhere but is
 * intentionally excluded here — sales leadership can read and approve, not
 * wipe ledger-affecting records. MASTER is the developer-debug login and
 * retains its universal bypass.
 */
export const canHardDelete = (user) => {
  return user?.role === 'SUPER_ADMIN' || user?.role === 'MASTER';
};

/**
 * Log when a MASTER user's universal-bypass is exercised so privileged
 * actions leave a trail. Kept as a simple console.warn — a dedicated audit
 * table would be cleaner but adds a hot-path DB write on every auth check.
 * Silently swallow any logging error so it can never break auth.
 */
const logMasterBypass = (user, checkType, allowedRoles) => {
  try {
    if (user?.role !== 'MASTER') return;
    console.warn(
      `[AUDIT] MASTER bypass — user=${user.id} email=${user.email || '?'} ${checkType}=${Array.isArray(allowedRoles) ? allowedRoles.join(',') : allowedRoles}`,
    );
  } catch {
    /* never throw from auth helper */
  }
};

/**
 * Check if user has a specific role (MASTER bypasses all checks)
 */
export const hasRole = (user, role) => {
  if (user?.role === 'MASTER') {
    logMasterBypass(user, 'hasRole', role);
    return true;
  }
  return user?.role === role;
};

/**
 * Check if user has any of the specified roles (MASTER bypasses all checks)
 */
export const hasAnyRole = (user, roles) => {
  if (user?.role === 'MASTER') {
    logMasterBypass(user, 'hasAnyRole', roles);
    return true;
  }
  return roles.includes(user?.role);
};

export default {
  isAdmin,
  isAdminOrTestUser,
  hasRole,
  hasAnyRole
};
