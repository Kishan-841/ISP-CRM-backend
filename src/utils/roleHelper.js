/**
 * Role Helper Utility
 * Helper functions for role-based access control
 */

/**
 * Check if user is SUPER_ADMIN (has full access)
 */
export const isAdmin = (user) => {
  return user?.role === 'SUPER_ADMIN';
};

// Alias for backward compatibility
export const isAdminOrTestUser = isAdmin;

/**
 * Check if user has a specific role
 */
export const hasRole = (user, role) => {
  return user?.role === role;
};

/**
 * Check if user has any of the specified roles
 */
export const hasAnyRole = (user, roles) => {
  return roles.includes(user?.role);
};

export default {
  isAdmin,
  isAdminOrTestUser,
  hasRole,
  hasAnyRole
};
