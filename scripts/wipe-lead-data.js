/**
 * FULL wipe — deletes everything except User (employees).
 *
 * Runs deletions in FK-safe order (children before parents).
 *
 * Usage: node scripts/wipe-lead-data.js
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const run = async () => {
  console.log('🗑️  Wiping ALL data except employees...\n');

  const steps = [
    // Notifications / logs
    ['notification',                       () => prisma.notification.deleteMany({})],
    ['emailLog',                           () => prisma.emailLog.deleteMany({})],
    ['statusChangeLog',                    () => prisma.statusChangeLog.deleteMany({})],
    ['documentUploadLink',                 () => prisma.documentUploadLink.deleteMany({})],

    // Call logs
    ['callLog',                            () => prisma.callLog.deleteMany({})],
    ['collectionCallLog',                  () => prisma.collectionCallLog.deleteMany({})],

    // Complaint attachments → assignments → complaints
    ['customerComplaintRequestAttachment', () => prisma.customerComplaintRequestAttachment.deleteMany({})],
    ['customerComplaintRequest',           () => prisma.customerComplaintRequest.deleteMany({})],
    ['complaintAttachment',                () => prisma.complaintAttachment.deleteMany({})],
    ['complaintAssignment',                () => prisma.complaintAssignment.deleteMany({})],
    ['complaint',                          () => prisma.complaint.deleteMany({})],

    // Service orders
    ['serviceOrder',                       () => prisma.serviceOrder.deleteMany({})],

    // SAM
    ['customerCommunication',              () => prisma.customerCommunication.deleteMany({})],
    ['sAMVisit',                           () => prisma.sAMVisit.deleteMany({})],
    ['sAMMeeting',                         () => prisma.sAMMeeting.deleteMany({})],
    ['sAMAssignmentHistory',               () => prisma.sAMAssignmentHistory.deleteMany({})],
    ['sAMAssignment',                      () => prisma.sAMAssignment.deleteMany({})],

    // Customer enquiries
    ['customerEnquiry',                    () => prisma.customerEnquiry.deleteMany({})],

    // Plan upgrade history
    ['planUpgradeHistory',                 () => prisma.planUpgradeHistory.deleteMany({})],

    // Delivery requests
    ['deliveryRequestLog',                 () => prisma.deliveryRequestLog.deleteMany({})],
    ['deliveryRequestItem',                () => prisma.deliveryRequestItem.deleteMany({})],
    ['deliveryRequest',                    () => prisma.deliveryRequest.deleteMany({})],

    // Financials
    ['ledgerEntry',                        () => prisma.ledgerEntry.deleteMany({})],
    ['creditNote',                         () => prisma.creditNote.deleteMany({})],
    ['advancePayment',                     () => prisma.advancePayment.deleteMany({})],
    ['invoicePayment',                     () => prisma.invoicePayment.deleteMany({})],
    ['invoice',                            () => prisma.invoice.deleteMany({})],

    // MOMs on leads
    ['mOM',                                () => prisma.mOM.deleteMany({})],

    // Leads + pivots
    ['leadProduct',                        () => prisma.leadProduct.deleteMany({})],
    ['lead',                               () => prisma.lead.deleteMany({})],

    // Campaigns
    ['campaignAssignment',                 () => prisma.campaignAssignment.deleteMany({})],
    ['campaignData',                       () => prisma.campaignData.deleteMany({})],
    ['campaign',                           () => prisma.campaign.deleteMany({})],

    // Vendor POs (must come before vendor)
    ['vendorPurchaseOrder',                () => prisma.vendorPurchaseOrder.deleteMany({})],

    // Store inventory (children first)
    ['receiptBatchLog',                    () => prisma.receiptBatchLog.deleteMany({})],
    ['storePurchaseOrderItem',             () => prisma.storePurchaseOrderItem.deleteMany({})],
    ['storePurchaseOrder',                 () => prisma.storePurchaseOrder.deleteMany({})],
    ['storeStockIntakeLog',                () => prisma.storeStockIntakeLog.deleteMany({})],
    ['storeSerialItem',                    () => prisma.storeSerialItem.deleteMany({})],
    ['storeStock',                         () => prisma.storeStock.deleteMany({})],
    ['storeProduct',                       () => prisma.storeProduct.deleteMany({})],
    ['inventoryItem',                      () => prisma.inventoryItem.deleteMany({})],

    // Vendors
    ['vendor',                             () => prisma.vendor.deleteMany({})],

    // Products
    ['product',                            () => prisma.product.deleteMany({})],

    // Complaint categories / close options
    ['complaintSubCategory',               () => prisma.complaintSubCategory.deleteMany({})],
    ['complaintCategory',                  () => prisma.complaintCategory.deleteMany({})],
    ['complaintCloseOption',               () => prisma.complaintCloseOption.deleteMany({})],

    // Disconnection categories
    ['disconnectionSubCategory',           () => prisma.disconnectionSubCategory.deleteMany({})],
    ['disconnectionCategory',              () => prisma.disconnectionCategory.deleteMany({})],

    // POP locations
    ['popLocation',                        () => prisma.popLocation.deleteMany({})],

    // Document sequences (so numbering restarts fresh)
    ['documentSequence',                   () => prisma.documentSequence.deleteMany({})],
  ];

  for (const [label, fn] of steps) {
    try {
      const result = await fn();
      console.log(`  ✓ ${label}: ${result.count} rows deleted`);
    } catch (e) {
      console.error(`  ✗ ${label} FAILED: ${e.message}`);
    }
  }

  const userCount = await prisma.user.count();
  console.log(`\n✅ Done. ${userCount} users (employees) preserved.`);
  await prisma.$disconnect();
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
