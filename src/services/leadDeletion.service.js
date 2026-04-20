/**
 * Lead Deletion Service — master-only, permanent, single-transaction.
 *
 * This service wipes EVERYTHING tied to a lead so that no trace remains in
 * the system. It is destructive and irreversible. Before calling
 * `deleteLeadEntirely`, always call `previewLeadDeletion` from the UI so the
 * user sees exactly what will be removed.
 *
 * Deletion order matters because several tables use `onDelete: Restrict` or
 * carry no foreign key at all (plain String refs via `customerId` /
 * `entityId`). We bottom-up delete children first, then the lead, then its
 * orphaned siblings (CampaignData + CallLog) when the caller opts in.
 */

import prisma from '../config/db.js';

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Fetch a lead with all the identifiers we need to reach related records.
 * Returns null if the lead does not exist.
 */
const fetchLeadForDeletion = (tx, leadId) =>
  tx.lead.findUnique({
    where: { id: leadId },
    select: {
      id: true,
      leadNumber: true,
      customerUsername: true,
      campaignDataId: true,
      campaignData: {
        select: {
          id: true,
          name: true,
          company: true,
          phone: true,
          email: true,
          isSelfGenerated: true,
          campaign: { select: { id: true, type: true, name: true } },
        },
      },
    },
  });

/**
 * Count every record that would be deleted for this lead.
 * Pure read — safe to call any number of times from the UI.
 */
export async function previewLeadDeletion(leadId) {
  const lead = await fetchLeadForDeletion(prisma, leadId);
  if (!lead) return null;

  const cd = lead.campaignData;

  // Invoice grandchildren — count before we count Invoices themselves.
  const invoiceIds = await prisma.invoice.findMany({
    where: { leadId },
    select: { id: true },
  }).then((rs) => rs.map((r) => r.id));

  const [
    invoicePayments,
    creditNotes,
    collectionCallsByInvoice,
    invoices,
    advancePayments,
    ledgerEntries,
    vendorPOs,
    deliveryRequests,
    collectionCallsByLead,
    statusChangeLogs,
    notifications,
    nexusConversations,
    samMeetings,
    samVisits,
    samCommunications,
    samAssignmentHistory,
    samAssignments,
    leadProducts,
    moms,
    uploadLinks,
    complaints,
    customerComplaintRequests,
    planUpgrades,
    serviceOrders,
    callLogs,
  ] = await Promise.all([
    invoiceIds.length ? prisma.invoicePayment.count({ where: { invoiceId: { in: invoiceIds } } }) : 0,
    invoiceIds.length ? prisma.creditNote.count({ where: { invoiceId: { in: invoiceIds } } }) : 0,
    invoiceIds.length ? prisma.collectionCallLog.count({ where: { invoiceId: { in: invoiceIds } } }) : 0,
    prisma.invoice.count({ where: { leadId } }),
    prisma.advancePayment.count({ where: { leadId } }),
    prisma.ledgerEntry.count({ where: { customerId: leadId } }),
    prisma.vendorPurchaseOrder.count({ where: { leadId } }),
    prisma.deliveryRequest.count({ where: { leadId } }),
    prisma.collectionCallLog.count({ where: { leadId } }),
    prisma.statusChangeLog.count({ where: { entityType: 'LEAD', entityId: leadId } }),
    // Notifications may reference leadId in metadata JSON (Prisma path query)
    prisma.notification.count({ where: { metadata: { path: ['leadId'], equals: leadId } } }).catch(() => 0),
    lead.customerUsername
      ? prisma.nexusConversation.count({ where: { customerUserId: lead.customerUsername } })
      : 0,
    prisma.sAMMeeting.count({ where: { customerId: leadId } }),
    prisma.sAMVisit.count({ where: { customerId: leadId } }),
    prisma.customerCommunication.count({ where: { customerId: leadId } }),
    prisma.sAMAssignmentHistory.count({ where: { customerId: leadId } }),
    prisma.sAMAssignment.count({ where: { customerId: leadId } }),
    prisma.leadProduct.count({ where: { leadId } }),
    prisma.mOM.count({ where: { leadId } }),
    prisma.documentUploadLink.count({ where: { leadId } }),
    prisma.complaint.count({ where: { leadId } }),
    prisma.customerComplaintRequest.count({ where: { leadId } }),
    prisma.planUpgradeHistory.count({ where: { leadId } }),
    prisma.serviceOrder.count({ where: { customerId: leadId } }),
    cd?.id ? prisma.callLog.count({ where: { campaignDataId: cd.id } }) : 0,
  ]);

  return {
    lead: {
      id: lead.id,
      leadNumber: lead.leadNumber,
      company: cd?.company || null,
      contactName: cd?.name || null,
      phone: cd?.phone || null,
      email: cd?.email || null,
      customerUsername: lead.customerUsername,
      campaignDataId: cd?.id || null,
      campaignName: cd?.campaign?.name || null,
      campaignIsSelf: cd?.campaign?.type === 'SELF' || cd?.isSelfGenerated === true,
    },
    counts: {
      // ↓ manual deletes (blockers)
      invoicePayments,
      creditNotes,
      collectionCallsByInvoice,
      invoices,
      advancePayments,
      ledgerEntries,
      vendorPurchaseOrders: vendorPOs,
      deliveryRequests,
      collectionCallsByLead,
      statusChangeLogs,
      notifications,
      nexusConversations,
      samMeetings,
      samVisits,
      samCommunications,
      samAssignmentHistory,
      samAssignments,
      // ↓ auto-cascade with Lead
      leadProducts,
      minutesOfMeeting: moms,
      documentUploadLinks: uploadLinks,
      complaints,
      customerComplaintRequests,
      planUpgradeHistory: planUpgrades,
      serviceOrders,
      // ↓ campaign-scoped (only if alsoDeleteCampaignData=true)
      callLogsIfCampaignDeleted: callLogs,
    },
  };
}

// ─── The big one ─────────────────────────────────────────────────────────

/**
 * Permanently delete every record tied to a lead.
 *
 * @param {Object} params
 * @param {string} params.leadId
 * @param {string} params.deletedById — user id performing the deletion
 * @param {string} params.reason — free text, min 10 chars (validated in controller)
 * @param {boolean} params.alsoDeleteCampaignData — if true, the lead's
 *        CampaignData (and its CallLogs) are also removed after the lead is
 *        deleted. Use for self-generated / test leads; leave false for leads
 *        that came through a real campaign to preserve the campaign history.
 * @returns {Promise<Object>} the audit row that was written
 * @throws if the lead doesn't exist
 */
export async function deleteLeadEntirely({ leadId, deletedById, reason, alsoDeleteCampaignData }) {
  // Capture identifiers + counts BEFORE we mutate anything, so the audit row
  // can carry a faithful snapshot even after the records are gone.
  const preview = await previewLeadDeletion(leadId);
  if (!preview) {
    const err = new Error('Lead not found.');
    err.status = 404;
    throw err;
  }

  return prisma.$transaction(async (tx) => {
    // ─── 1. NEXUS chat (customer portal traces) ─────────────────────────
    if (preview.lead.customerUsername) {
      await tx.nexusConversation.deleteMany({
        where: { customerUserId: preview.lead.customerUsername },
      });
    }

    // ─── 2. SAM post-sale records ───────────────────────────────────────
    await tx.sAMMeeting.deleteMany({ where: { customerId: leadId } });
    await tx.sAMVisit.deleteMany({ where: { customerId: leadId } });
    await tx.customerCommunication.deleteMany({ where: { customerId: leadId } });
    await tx.sAMAssignmentHistory.deleteMany({ where: { customerId: leadId } });
    await tx.sAMAssignment.deleteMany({ where: { customerId: leadId } });

    // ─── 3. Invoice grandchildren → Invoices ────────────────────────────
    const invoiceIds = await tx.invoice.findMany({
      where: { leadId },
      select: { id: true },
    }).then((rs) => rs.map((r) => r.id));

    if (invoiceIds.length) {
      await tx.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await tx.creditNote.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await tx.collectionCallLog.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    }
    await tx.invoice.deleteMany({ where: { leadId } });
    await tx.advancePayment.deleteMany({ where: { leadId } });

    // ─── 4. Ledger (scoped strictly to this lead's customerId) ──────────
    //     Important: customerId = leadId, so no cross-lead deletion risk.
    await tx.ledgerEntry.deleteMany({ where: { customerId: leadId } });

    // ─── 5. Vendor POs ──────────────────────────────────────────────────
    await tx.vendorPurchaseOrder.deleteMany({ where: { leadId } });

    // ─── 6. Delivery requests (items + logs cascade) ───────────────────
    await tx.deliveryRequest.deleteMany({ where: { leadId } });

    // ─── 7. Remaining lead-scoped collection calls (if any without invoiceId) ─
    await tx.collectionCallLog.deleteMany({ where: { leadId } });

    // ─── 8. Status change logs for this entity ─────────────────────────
    await tx.statusChangeLog.deleteMany({
      where: { entityType: 'LEAD', entityId: leadId },
    });

    // ─── 9. Notifications referencing leadId in metadata ───────────────
    try {
      await tx.notification.deleteMany({
        where: { metadata: { path: ['leadId'], equals: leadId } },
      });
    } catch {
      /* JSON path query can fail silently on weird metadata shapes; skip */
    }

    // ─── 10. The Lead itself — cascades to ───────────────────────────────
    //     LeadProduct, MOM, DocumentUploadLink, PlanUpgradeHistory, Complaint
    //     (+ ComplaintAssignment + ComplaintAttachment), CustomerComplaintRequest,
    //     ServiceOrder. These do NOT need manual deletion.
    await tx.lead.delete({ where: { id: leadId } });

    // ─── 11. Optionally wipe the underlying CampaignData + its CallLogs ──
    if (alsoDeleteCampaignData && preview.lead.campaignDataId) {
      // CallLog has onDelete: Cascade on campaignData, so deleting CD removes them.
      await tx.campaignData.delete({ where: { id: preview.lead.campaignDataId } });
    }

    // ─── 12. Write the audit row (can never be cascaded away) ───────────
    const audit = await tx.leadDeletionAudit.create({
      data: {
        leadId,
        leadNumber: preview.lead.leadNumber,
        companyName: preview.lead.company,
        contactName: preview.lead.contactName,
        phone: preview.lead.phone,
        email: preview.lead.email,
        customerUsername: preview.lead.customerUsername,
        alsoDeletedCampaignData: !!alsoDeleteCampaignData,
        deletedById,
        reason,
        snapshot: {
          counts: preview.counts,
          campaign: preview.lead.campaignName,
        },
      },
    });
    return audit;
  }, {
    // Give the transaction room to run — deletions + writes can take a while.
    timeout: 30000,
  });
}

/**
 * List deletion audit rows. Returns paginated results.
 */
export async function listDeletionAudits({ page = 1, limit = 20 }) {
  const skip = (page - 1) * limit;
  const [total, items] = await Promise.all([
    prisma.leadDeletionAudit.count(),
    prisma.leadDeletionAudit.findMany({
      orderBy: { deletedAt: 'desc' },
      skip,
      take: limit,
      include: { deletedBy: { select: { id: true, name: true, email: true, role: true } } },
    }),
  ]);
  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}
