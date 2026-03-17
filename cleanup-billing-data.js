import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function cleanupBillingData() {
  try {
    console.log('🧹 Starting cleanup of all billing data...\n');

    const result = await prisma.$transaction(async (tx) => {
      // 1. Delete all ledger entries
      console.log('Deleting ledger entries...');
      const deletedLedgers = await tx.ledgerEntry.deleteMany({});
      console.log(`✅ Deleted ${deletedLedgers.count} ledger entries`);

      // 2. Delete all invoice payments
      console.log('Deleting invoice payments...');
      const deletedPayments = await tx.invoicePayment.deleteMany({});
      console.log(`✅ Deleted ${deletedPayments.count} invoice payments`);

      // 3. Delete all advance payments
      console.log('Deleting advance payments...');
      const deletedAdvances = await tx.advancePayment.deleteMany({});
      console.log(`✅ Deleted ${deletedAdvances.count} advance payments`);

      // 4. Delete all credit notes
      console.log('Deleting credit notes...');
      const deletedCreditNotes = await tx.creditNote.deleteMany({});
      console.log(`✅ Deleted ${deletedCreditNotes.count} credit notes`);

      // 5. Delete all collection call logs (linked to invoices)
      console.log('Deleting collection call logs...');
      const deletedCollectionLogs = await tx.collectionCallLog.deleteMany({});
      console.log(`✅ Deleted ${deletedCollectionLogs.count} collection call logs`);

      // 6. Delete all invoices
      console.log('Deleting invoices...');
      const deletedInvoices = await tx.invoice.deleteMany({});
      console.log(`✅ Deleted ${deletedInvoices.count} invoices`);

      // 7. Delete all plan upgrade history
      console.log('Deleting plan upgrade/downgrade history...');
      const deletedPlanHistory = await tx.planUpgradeHistory.deleteMany({});
      console.log(`✅ Deleted ${deletedPlanHistory.count} plan history records`);

      // 8. Reset all leads with actual plans
      console.log('Resetting leads to fresh state...');
      const updatedLeads = await tx.lead.updateMany({
        where: {
          actualPlanCreatedAt: { not: null }
        },
        data: {
          // Clear actual plan data
          actualPlanName: null,
          actualPlanBandwidth: null,
          actualPlanUploadBandwidth: null,
          actualPlanBillingType: null,
          actualPlanPrice: null,
          actualPlanValidityDays: null,
          actualPlanIsActive: false,
          actualPlanStartDate: null,
          actualPlanEndDate: null,
          actualPlanNotes: null,
          actualPlanCreatedAt: null,
        }
      });
      console.log(`✅ Reset ${updatedLeads.count} leads`);

      return {
        deletedLedgers: deletedLedgers.count,
        deletedPayments: deletedPayments.count,
        deletedAdvances: deletedAdvances.count,
        deletedCreditNotes: deletedCreditNotes.count,
        deletedCollectionLogs: deletedCollectionLogs.count,
        deletedInvoices: deletedInvoices.count,
        deletedPlanHistory: deletedPlanHistory.count,
        updatedLeads: updatedLeads.count
      };
    });

    console.log('\n✨ Cleanup completed successfully!\n');
    console.log('📊 Summary:');
    console.log(`   - Ledger entries deleted: ${result.deletedLedgers}`);
    console.log(`   - Invoice payments deleted: ${result.deletedPayments}`);
    console.log(`   - Advance payments deleted: ${result.deletedAdvances}`);
    console.log(`   - Credit notes deleted: ${result.deletedCreditNotes}`);
    console.log(`   - Collection call logs deleted: ${result.deletedCollectionLogs}`);
    console.log(`   - Invoices deleted: ${result.deletedInvoices}`);
    console.log(`   - Plan upgrade/downgrade history deleted: ${result.deletedPlanHistory}`);
    console.log(`   - Leads reset: ${result.updatedLeads}`);
    console.log('\n🎯 Your database is now clean and ready for fresh testing!');

  } catch (error) {
    console.error('❌ Error during cleanup:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

cleanupBillingData();
