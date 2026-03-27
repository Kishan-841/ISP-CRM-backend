/**
 * Role Helper Utility
 * Helper functions for role-based access control
 */

/**
 * Check if user is SUPER_ADMIN or MASTER (has full access)
 */
export const isAdmin = (user) => {
  return user?.role === 'SUPER_ADMIN' || user?.role === 'MASTER';
};

// Alias for backward compatibility
export const isAdminOrTestUser = isAdmin;

/**
 * Check if user has a specific role (MASTER bypasses all checks)
 */
export const hasRole = (user, role) => {
  if (user?.role === 'MASTER') return true;
  return user?.role === role;
};

/**
 * Check if user has any of the specified roles (MASTER bypasses all checks)
 */
export const hasAnyRole = (user, roles) => {
  if (user?.role === 'MASTER') return true;
  return roles.includes(user?.role);
};

export default {
  isAdmin,
  isAdminOrTestUser,
  hasRole,
  hasAnyRole
};
