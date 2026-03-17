/**
 * One-time script to backfill ledger entries from existing data
 * Run with: node src/scripts/backfillLedger.js
 */

import { backfillLedgerEntries } from '../services/ledger.service.js';

const run = async () => {
  console.log('Starting ledger backfill...\n');

  try {
    const result = await backfillLedgerEntries();
    console.log('\n========================================');
    console.log('BACKFILL COMPLETE');
    console.log('========================================');
    console.log(`Customers processed: ${result.customersProcessed}`);
    console.log(`Ledger entries created: ${result.totalEntries}`);
    console.log('========================================\n');
    process.exit(0);
  } catch (error) {
    console.error('Backfill failed:', error);
    process.exit(1);
  }
};

run();
