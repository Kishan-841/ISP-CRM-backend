/**
 * Cancelling a lead out of the delivery pipeline.
 *
 * Lives in its own module rather than lead.controller.js (~13k lines) because
 * it coordinates four subsystems - delivery requests, store stock, invoices and
 * the ledger - and needs to be readable as one piece.
 */
import prisma from '../config/db.js';
import { asyncHandler } from '../utils/controllerHelper.js';
import { hasAnyRole, isAdminOrTestUser } from '../utils/roleHelper.js';
import { canCancelLead } from '../utils/leadCancellation.js';
import { getLeadStage } from '../utils/deliveryStage.js';
import { returnSerialToStock, isSerialInStock } from '../services/materialReturn.service.js';
import { createInvoiceCancellationLedgerEntry } from '../services/ledger.service.js';
import { logStatusChange } from '../services/statusChangeLog.service.js';
import { createNotification, notifyAllAdmins } from '../services/notification.service.js';
import { emitSidebarRefresh, emitSidebarRefreshByRole } from '../sockets/index.js';

/** Delivery request states that still hold a claim on material. */
const OPEN_REQUEST_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'ASSIGNED', 'DISPATCHED'];
/** Invoice states that leave the customer owing something. */
const UNPAID_INVOICE_STATUSES = ['DRAFT', 'GENERATED', 'PARTIALLY_PAID', 'OVERDUE'];

/**
 * Work out what cancelling this lead entails. Pure - no DB, no I/O - so the
 * decisions are testable without a database.
 *
 * @returns {{ serials: Array<{serialNumber, productId, deliveryItem}>,
 *             bulkItems: Array<{itemId, productId, quantity}>,
 *             requestIds: string[], invoiceIds: string[] }}
 */
export const planCancellation = (lead) => {
  const serials = [];
  const bulkItems = [];
  const seen = new Set();
  const requestIds = [];

  for (const request of lead.deliveryRequests || []) {
    if (OPEN_REQUEST_STATUSES.includes(request.status)) requestIds.push(request.id);

    for (const item of request.items || []) {
      const assigned = item.assignedSerialNumbers || [];

      // Bulk material (fiber, `mtrs`) has no serial, so the lead it came from
      // cannot be verified - the same phase-1 limitation the store's material
      // return flow documents. Reported, never credited back to stock.
      if (assigned.length === 0) {
        if (item.assignedQuantity > 0) {
          bulkItems.push({ itemId: item.id, productId: item.productId, quantity: item.assignedQuantity });
        }
        continue;
      }

      const returned = new Set(item.returnedSerialNumbers || []);
      for (const serialNumber of assigned) {
        if (returned.has(serialNumber) || seen.has(serialNumber)) continue;
        seen.add(serialNumber);
        serials.push({ serialNumber, productId: item.productId, deliveryItem: item });
      }
    }
  }

  const invoiceIds = (lead.invoices || [])
    .filter(i => UNPAID_INVOICE_STATUSES.includes(i.status))
    .map(i => i.id);

  return { serials, bulkItems, requestIds, invoiceIds };
};

export const cancelDeliveryLead = asyncHandler(async function cancelDeliveryLead(req, res) {
  const userId = req.user.id;
  const { id } = req.params;
  const { reason } = req.body;

  if (!hasAnyRole(req.user, ['DELIVERY_TEAM', 'ADMIN', 'SUPER_ADMIN']) && !isAdminOrTestUser(req.user)) {
    return res.status(403).json({ message: 'Only the delivery team or an admin can cancel a lead.' });
  }

  const lead = await prisma.lead.findUnique({
    where: { id },
    include: {
      campaignData: { select: { company: true } },
      deliveryRequests: {
        // Newest first, matching getDeliveryQueue - getLeadStage reads
        // deliveryRequests[0], so the order here decides which request the
        // recorded stage is derived from. Unlike the queue we do NOT filter or
        // `take: 1`: every request is needed below, open ones to void and
        // supplementary ones because they still hold material to return.
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          pushedToNocAt: true,
          isSupplementary: true,
          items: {
            where: { isAssigned: true },
            select: {
              id: true,
              productId: true,
              assignedSerialNumbers: true,
              returnedSerialNumbers: true,
              assignedQuantity: true,
              assignedFromPOItemId: true
            }
          }
        }
      },
      invoices: { select: { id: true, invoiceNumber: true, status: true, grandTotal: true, totalPaidAmount: true, totalCreditAmount: true, remainingAmount: true } }
    }
  });

  if (!lead) return res.status(404).json({ message: 'Lead not found.' });

  const verdict = canCancelLead(lead, reason);
  if (!verdict.allowed) return res.status(400).json({ message: verdict.message, code: verdict.code });

  // Captured BEFORE deliveryStatus is overwritten - afterwards the board stage
  // is unrecoverable.
  //
  // Supplementary ("Add More Material") requests are excluded so the stage is
  // derived from the same request the board showed the user: getDeliveryQueue
  // filters `isSupplementary: false`, and without this a lead with a null
  // deliveryStatus plus a supplementary request would record a stage nobody saw.
  const stageAtCancellation = getLeadStage({
    ...lead,
    deliveryRequests: lead.deliveryRequests.filter(r => !r.isSupplementary)
  });
  // Deliberately ALL requests, supplementary included - they hold material that
  // must come back to stock and still need voiding.
  const plan = planCancellation(lead);
  const trimmedReason = String(reason).trim();

  // Every effect below is one transaction by design: committing some and not
  // others would release hardware for a live lead, or credit a ledger for an
  // invoice still open.
  //
  // The budget is raised from Prisma's 5s interactive default because each
  // serial costs ~5 sequential round trips (in-stock check, batch lookup, batch
  // update, item update, MaterialReturn create) - a lead carrying many serials
  // would otherwise hit P2028. That rollback is the correct failure, but the
  // operation should fit rather than depend on the lead being small.
  const returnedSerials = await prisma.$transaction(async (tx) => {
    const done = [];

    for (const { serialNumber, productId, deliveryItem } of plan.serials) {
      // A serial returned by hand before the cancellation is already in stock;
      // crediting it again would invent inventory.
      if (await isSerialInStock(tx, serialNumber)) continue;

      const targetPOItemId = await returnSerialToStock(tx, {
        deliveryItem, productId, serialNumber, condition: 'GOOD', userId
      });

      await tx.deliveryRequestItem.update({
        where: { id: deliveryItem.id },
        data: {
          returnedSerialNumbers: [...new Set([...(deliveryItem.returnedSerialNumbers || []), serialNumber])]
        }
      });

      await tx.materialReturn.create({
        data: {
          serialNumber,
          productId,
          leadId: lead.id,
          deliveryRequestItemId: deliveryItem.id,
          condition: 'GOOD',
          status: 'APPROVED',
          remark: `Lead cancelled: ${trimmedReason}`,
          targetPOItemId,
          returnedById: userId,
          reviewedById: userId,
          reviewedAt: new Date()
        }
      });

      done.push(serialNumber);
    }

    if (plan.requestIds.length > 0) {
      await tx.deliveryRequest.updateMany({
        where: { id: { in: plan.requestIds } },
        data: { status: 'CANCELLED' }
      });
      await tx.deliveryRequestLog.createMany({
        data: plan.requestIds.map(deliveryRequestId => ({
          deliveryRequestId,
          action: 'CANCELLED',
          performedById: userId,
          details: { reason: trimmedReason, leadCancelled: true }
        }))
      });
    }

    for (const invoiceId of plan.invoiceIds) {
      const invoice = lead.invoices.find(i => i.id === invoiceId);
      await createInvoiceCancellationLedgerEntry(invoice, lead.id, userId, tx);
      await tx.invoice.update({ where: { id: invoiceId }, data: { status: 'CANCELLED' } });
    }

    await tx.lead.update({
      where: { id: lead.id },
      data: {
        deliveryStatus: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledById: userId,
        cancelledReason: trimmedReason,
        cancelledAtStage: stageAtCancellation,
        // The ONLY flag the daily invoice job reads (invoiceGeneration.js:264-269).
        actualPlanIsActive: false
      }
    });

    return done;
  }, { timeout: 30000, maxWait: 10000 });

  logStatusChange({
    entityType: 'LEAD',
    entityId: lead.id,
    field: 'deliveryStatus',
    oldValue: lead.deliveryStatus,
    newValue: 'CANCELLED',
    changedById: userId,
    reason: trimmedReason
  });

  const company = lead.campaignData?.company || 'a lead';
  if (lead.assignedToId) {
    await createNotification(
      lead.assignedToId,
      'LEAD_CANCELLED',
      'Lead Cancelled',
      `"${company}" was cancelled at the ${stageAtCancellation.replace(/_/g, ' ')} stage: ${trimmedReason}`,
      { leadId: lead.id }
    );
    emitSidebarRefresh(lead.assignedToId);
  }
  await notifyAllAdmins(
    'LEAD_CANCELLED',
    'Lead Cancelled',
    `"${company}" was cancelled during delivery: ${trimmedReason}`,
    { leadId: lead.id }
  );
  emitSidebarRefreshByRole('DELIVERY_TEAM');
  emitSidebarRefreshByRole('STORE_MANAGER');
  emitSidebarRefreshByRole('SUPER_ADMIN');

  res.json({
    message: 'Lead cancelled.',
    data: {
      leadId: lead.id,
      cancelledAtStage: stageAtCancellation,
      serialsReturned: returnedSerials,
      // Fiber and other non-serial material is NOT credited back to stock.
      // Surfaced so the store knows what to reconcile by hand.
      bulkItemsNotReturned: plan.bulkItems,
      requestsCancelled: plan.requestIds.length,
      invoicesCancelled: plan.invoiceIds.length
    }
  });
});
