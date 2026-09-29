/**
 * Roles that behave exactly like a solo BDM (see
 * docs/superpowers/specs/2026-09-29-sam-solo-bdm-role-design.md).
 *
 * Single source of truth: every permission gate or data-scoping branch that
 * means "a BDM working their own leads" must use these helpers instead of
 * comparing against the literal 'BDM', so SAM (and any future BDM-like role)
 * can never be missed — or worse, fall through to an unscoped branch.
 *
 * BDM_CP and BDM_TEAM_LEADER are deliberately NOT here: they have their own
 * branches (CP-vendor queue, team scope).
 */
import { hasAnyRole } from './roleHelper.js';

export const BDM_LIKE_ROLES = Object.freeze(['BDM', 'SAM']);

// Raw role check — no MASTER bypass. Use where the existing code compared
// req.user.role directly (e.g. data scoping that must not treat MASTER as a BDM).
export const isBdmLikeRole = (role) => BDM_LIKE_ROLES.includes(role);

// Permission check — MASTER passes, matching hasRole(user, 'BDM') semantics.
export const isBdmLike = (user) => hasAnyRole(user, BDM_LIKE_ROLES);
