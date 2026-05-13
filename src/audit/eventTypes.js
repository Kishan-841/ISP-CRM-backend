/**
 * (model, action) → stable dotted slug.
 * Slugs are part of the audit log's public API: dashboards filter on them.
 * If a model gets renamed in Prisma, KEEP its slug stable here by mapping
 * the old slug explicitly. Adding a new slug is fine.
 */
export function toEventType(model, action) {
  const slug = model
    .replace(/([a-z])([A-Z])/g, '$1-$2')   // VendorPurchaseOrder → Vendor-Purchase-Order
    .toLowerCase();
  return `${slug}.${action.toLowerCase()}`;
}
