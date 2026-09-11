// The ONLY place that knows which products a user may see or attach.
//
// Rule: a product with NO assignments is visible to everyone; a product with
// assignments is visible only to the users named on it. Restriction is opt-in,
// so existing products (ILL) keep working with no backfill.
//
// Both the read filter and the write guard are built from the same fragment
// below. Keeping them in one file is deliberate: a reader and a writer that
// each carry their own copy of a rule is exactly how the delivery-material bug
// happened, where a UI hid something the API still accepted.

// Roles whose product list is narrowed. Everyone else — ISR, SAM, OPS,
// Accounts, Admin, Master, Sales Director, Super Admin — is unfiltered BY
// CONSTRUCTION, so there is no bypass list to keep in sync with this one.
export const PRODUCT_RESTRICTED_ROLES = ['BDM', 'BDM_CP', 'BDM_TEAM_LEADER'];

export const isProductRestrictedRole = (user) =>
  PRODUCT_RESTRICTED_ROLES.includes(user?.role);

/**
 * Prisma `where` fragment restricting products to what this user may use.
 * Returns {} for unrestricted roles, so it is always safe to spread.
 *
 * @param {{id: string, role: string}|null} user - req.user
 * @returns {object} spreadable into a Prisma `where`
 */
export const productVisibilityWhere = (user) =>
  isProductRestrictedRole(user)
    ? {
        OR: [
          { assignments: { none: {} } },              // unassigned → everyone
          { assignments: { some: { userId: user.id } } }, // assigned to me
        ],
      }
    : {};

/**
 * Reject an attempt to attach products this user may not use.
 *
 * A hidden dropdown is cosmetic — a stale browser tab or a replayed request
 * would otherwise still attach a restricted product. This is the enforcement.
 *
 * No-op for unrestricted roles and for empty input, so callers can invoke it
 * unconditionally without branching.
 *
 * Throws an error carrying `statusCode: 400` and naming the offending products,
 * so the user is told what to fix rather than having their input dropped.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{id: string, role: string}} user - req.user
 * @param {string[]} productIds
 */
export async function assertProductsAllowed(prisma, user, productIds) {
  if (!isProductRestrictedRole(user)) return;
  if (!Array.isArray(productIds) || productIds.length === 0) return;

  const unique = [...new Set(productIds)];

  const allowed = await prisma.product.findMany({
    where: { id: { in: unique }, ...productVisibilityWhere(user) },
    select: { id: true },
  });
  const allowedIds = new Set(allowed.map((p) => p.id));
  const denied = unique.filter((id) => !allowedIds.has(id));
  if (denied.length === 0) return;

  // Name the products rather than echoing UUIDs — the message is read by a BDM.
  const rows = await prisma.product.findMany({
    where: { id: { in: denied } },
    select: { title: true },
  });
  const label = rows.length > 0
    ? rows.map((r) => `"${r.title}"`).join(', ')
    : 'the selected product(s)';

  throw Object.assign(
    new Error(`You do not have access to ${label}. Ask an admin to assign it to you.`),
    { statusCode: 400 }
  );
}
