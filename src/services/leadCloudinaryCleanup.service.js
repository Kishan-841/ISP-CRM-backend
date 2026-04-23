/**
 * Cloudinary cleanup for a deleted lead.
 *
 * When a lead is permanently deleted we also need to remove every file we
 * pushed to Cloudinary for that lead — otherwise those blobs keep eating
 * free-tier credits forever. This service does two things:
 *
 *   1. `collectCloudinaryRefs(leadId)` — runs BEFORE the deletion transaction,
 *      capturing every Cloudinary reference tied to the lead (folders + URL
 *      fields). Cascade deletes in the transaction would otherwise erase the
 *      complaint / service-order IDs we need to build the folder prefixes.
 *
 *   2. `cleanupLeadCloudinary(refs)` — runs AFTER the transaction commits.
 *      Calls Cloudinary's `delete_resources_by_prefix` for each folder + empty
 *      folder, and individual `destroy` for any URL-referenced files that
 *      don't sit under a lead-scoped folder (speed tests, quotations, etc.).
 *      Fire-and-forget from the caller's perspective — we log what happened
 *      but never roll back the DB because a CDN call failed.
 *
 * Cloudinary folder layout (as configured in config/cloudinary.js):
 *   isp_crm/documents/{leadId}/{documentType}/   — typed doc uploads
 *   isp_crm/complaints/{complaintId}/            — complaint attachments
 *   isp_crm/orders/{orderId}/                    — service order attachments
 *   isp_crm/documents/                           — legacy generic uploads
 *                                                  (no leadId in path — must
 *                                                   be cleaned by public_id)
 */

// Import the already-configured Cloudinary singleton from config/cloudinary.js
// (not direct from the 'cloudinary' package) so credentials are guaranteed
// applied regardless of module import order.
import { cloudinary } from '../config/cloudinary.js';
import prisma from '../config/db.js';

// Resource-type classification based on file extension / known Cloudinary
// layout. `raw` for PDFs/docs, `image` for jpg/png. Cloudinary stores them
// in separate namespaces so a delete_resources_by_prefix on the wrong type
// silently matches nothing.
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);
const RAW_EXTS = new Set(['pdf', 'doc', 'docx']);

/**
 * Collect every Cloudinary reference tied to a lead, before its DB records
 * are cascaded away by the deletion transaction. Safe to call against a
 * fully-detached lead — returns best-effort refs from whatever still exists.
 */
export async function collectCloudinaryRefs(leadId) {
  const refs = {
    leadId,
    // Folder prefixes: will be cleaned via delete_resources_by_prefix.
    folderPrefixes: [`isp_crm/documents/${leadId}`],
    complaintIds: [],
    serviceOrderIds: [],
    // Individual URL fields that live outside a lead-scoped folder.
    urls: [],
  };

  // Pull the lead's own URL-bearing fields + the related IDs we need to
  // reconstruct complaint/order folder prefixes.
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: {
      speedTestScreenshot: true,
      latencyTestScreenshot: true,
      customerAcceptanceScreenshot: true,
      quotationAttachments: true,
      complaints: { select: { id: true } },
      serviceOrders: { select: { id: true } },
    },
  });

  if (!lead) return refs; // Lead already gone — return whatever skeleton we had.

  refs.complaintIds = lead.complaints.map((c) => c.id);
  refs.serviceOrderIds = lead.serviceOrders.map((o) => o.id);
  for (const cid of refs.complaintIds) refs.folderPrefixes.push(`isp_crm/complaints/${cid}`);
  for (const oid of refs.serviceOrderIds) refs.folderPrefixes.push(`isp_crm/orders/${oid}`);

  // Legacy URL-based fields. quotationAttachments is a JSON array of {url, filename, …}.
  const pushUrl = (u) => u && typeof u === 'string' && u.startsWith('http') && refs.urls.push(u);
  pushUrl(lead.speedTestScreenshot);
  pushUrl(lead.latencyTestScreenshot);
  pushUrl(lead.customerAcceptanceScreenshot);
  if (Array.isArray(lead.quotationAttachments)) {
    for (const att of lead.quotationAttachments) pushUrl(att?.url);
  }

  return refs;
}

/**
 * Extract Cloudinary public_id + resource_type from an uploaded URL.
 *
 * URL shape:
 *   https://res.cloudinary.com/<cloud>/<resource_type>/upload/[v<version>/]<public_id>[.<ext>]
 *
 * For images/videos the public_id is stored WITHOUT the extension; the
 * delete call wants the extensionless form. For `raw` uploads Cloudinary
 * keeps the extension in the public_id — preserve it.
 */
function parseCloudinaryUrl(url) {
  try {
    const m = url.match(/\/(image|video|raw)\/upload\/(?:v\d+\/)?(.+)$/);
    if (!m) return null;
    const resourceType = m[1];
    let publicId = m[2];
    if (resourceType !== 'raw') {
      // Strip the file extension for image/video
      publicId = publicId.replace(/\.[^./]+$/, '');
    }
    return { resourceType, publicId };
  } catch {
    return null;
  }
}

/**
 * Cleanup all Cloudinary files tracked in `refs`. Never throws — logs any
 * failures and returns a summary so callers can include it in audit trails.
 */
export async function cleanupLeadCloudinary(refs) {
  const summary = {
    prefixesCleared: [],
    urlsDestroyed: [],
    failures: [],
  };

  // Fold each prefix through both resource types. Cloudinary does not expose
  // a "delete everything under this prefix regardless of type" API — the
  // `resource_type` is part of the namespace.
  for (const prefix of refs.folderPrefixes) {
    for (const resource_type of ['image', 'raw']) {
      try {
        const res = await cloudinary.api.delete_resources_by_prefix(prefix, { resource_type });
        const deletedCount = Object.keys(res?.deleted || {}).length;
        if (deletedCount > 0) {
          summary.prefixesCleared.push({ prefix, resource_type, deletedCount });
        }
      } catch (err) {
        summary.failures.push({ prefix, resource_type, error: err?.message || String(err) });
      }
    }
    // Try to remove the now-empty folder itself. Silently ignores if it
    // doesn't exist or still has subfolders (Cloudinary returns a specific error).
    try { await cloudinary.api.delete_folder(prefix); } catch { /* expected for non-empty / missing */ }
  }

  // URL-based singletons that live outside the lead folder (legacy).
  for (const url of refs.urls) {
    const parsed = parseCloudinaryUrl(url);
    if (!parsed) {
      summary.failures.push({ url, error: 'Could not parse Cloudinary public_id' });
      continue;
    }
    try {
      await cloudinary.uploader.destroy(parsed.publicId, { resource_type: parsed.resourceType });
      summary.urlsDestroyed.push(parsed.publicId);
    } catch (err) {
      summary.failures.push({ url, publicId: parsed.publicId, error: err?.message || String(err) });
    }
  }

  const label = `[leadCloudinaryCleanup] lead=${refs.leadId}`;
  if (summary.prefixesCleared.length || summary.urlsDestroyed.length) {
    console.log(`${label} cleaned ${summary.prefixesCleared.length} prefix(es) + ${summary.urlsDestroyed.length} url(s)`);
  }
  if (summary.failures.length) {
    console.warn(`${label} ${summary.failures.length} failure(s):`, summary.failures);
  }

  return summary;
}
