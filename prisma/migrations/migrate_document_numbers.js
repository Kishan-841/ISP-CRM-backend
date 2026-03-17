/**
 * Migration Script: Update Document Numbers to New Format
 *
 * New Format: PREFIX/DD/MM/YY-XXXX
 * - Invoice: GLL/DD/MM/YY-XXXX (e.g., GLL/27/01/26-0001)
 * - Receipt: RCP/DD/MM/YY-XXXX (e.g., RCP/27/01/26-0001)
 * - Credit Note: CN/DD/MM/YY-XXXX (e.g., CN/27/01/26-0001)
 *
 * Rules:
 * - Sequence never resets (global counter per document type)
 * - 4-digit padding (0001, 0002... 9999, 10000...)
 *
 * Run this script AFTER running: npx prisma migrate dev
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Format date as DD/MM/YY
 */
const formatDate = (date) => {
  const d = new Date(date);
  const day = d.getDate().toString().padStart(2, '0');
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const year = d.getFullYear().toString().slice(-2);
  return `${day}/${month}/${year}`;
};

/**
 * Migrate all invoices to new format
 */
const migrateInvoices = async () => {
  console.log('\n--- Migrating Invoices ---');

  const invoices = await prisma.invoice.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      invoiceNumber: true,
      invoiceDate: true,
      createdAt: true
    }
  });

  console.log(`Found ${invoices.length} invoices to migrate`);

  let counter = 0;
  for (const invoice of invoices) {
    counter++;
    const dateStr = formatDate(invoice.invoiceDate || invoice.createdAt);
    const numberStr = counter.toString().padStart(4, '0');
    const newNumber = `GLL/${dateStr}-${numberStr}`;

    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { invoiceNumber: newNumber }
    });

    console.log(`  ${invoice.invoiceNumber} -> ${newNumber}`);
  }

  // Update DocumentSequence
  await prisma.documentSequence.upsert({
    where: { documentType: 'INVOICE' },
    create: {
      documentType: 'INVOICE',
      prefix: 'GLL',
      lastNumber: counter
    },
    update: {
      lastNumber: counter
    }
  });

  console.log(`Migrated ${counter} invoices. Sequence set to ${counter}.`);
  return counter;
};

/**
 * Migrate all receipts (InvoicePayment) to new format
 */
const migrateReceipts = async () => {
  console.log('\n--- Migrating Receipts ---');

  const receipts = await prisma.invoicePayment.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      receiptNumber: true,
      paymentDate: true,
      createdAt: true
    }
  });

  console.log(`Found ${receipts.length} receipts to migrate`);

  let counter = 0;
  for (const receipt of receipts) {
    counter++;
    const dateStr = formatDate(receipt.paymentDate || receipt.createdAt);
    const numberStr = counter.toString().padStart(4, '0');
    const newNumber = `RCP/${dateStr}-${numberStr}`;

    await prisma.invoicePayment.update({
      where: { id: receipt.id },
      data: { receiptNumber: newNumber }
    });

    console.log(`  ${receipt.receiptNumber} -> ${newNumber}`);
  }

  // Update DocumentSequence
  await prisma.documentSequence.upsert({
    where: { documentType: 'RECEIPT' },
    create: {
      documentType: 'RECEIPT',
      prefix: 'RCP',
      lastNumber: counter
    },
    update: {
      lastNumber: counter
    }
  });

  console.log(`Migrated ${counter} receipts. Sequence set to ${counter}.`);
  return counter;
};

/**
 * Migrate all credit notes to new format
 */
const migrateCreditNotes = async () => {
  console.log('\n--- Migrating Credit Notes ---');

  const creditNotes = await prisma.creditNote.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      creditNoteNumber: true,
      creditNoteDate: true,
      createdAt: true
    }
  });

  console.log(`Found ${creditNotes.length} credit notes to migrate`);

  let counter = 0;
  for (const cn of creditNotes) {
    counter++;
    const dateStr = formatDate(cn.creditNoteDate || cn.createdAt);
    const numberStr = counter.toString().padStart(4, '0');
    const newNumber = `CN/${dateStr}-${numberStr}`;

    await prisma.creditNote.update({
      where: { id: cn.id },
      data: { creditNoteNumber: newNumber }
    });

    console.log(`  ${cn.creditNoteNumber} -> ${newNumber}`);
  }

  // Update DocumentSequence
  await prisma.documentSequence.upsert({
    where: { documentType: 'CREDIT_NOTE' },
    create: {
      documentType: 'CREDIT_NOTE',
      prefix: 'CN',
      lastNumber: counter
    },
    update: {
      lastNumber: counter
    }
  });

  console.log(`Migrated ${counter} credit notes. Sequence set to ${counter}.`);
  return counter;
};

/**
 * Update ledger entries with new reference numbers
 */
const updateLedgerEntries = async () => {
  console.log('\n--- Updating Ledger Entries ---');

  // Update INVOICE ledger entries
  const invoiceLedgerEntries = await prisma.ledgerEntry.findMany({
    where: { entryType: 'INVOICE' },
    select: { id: true, referenceId: true }
  });

  let invoiceCount = 0;
  for (const entry of invoiceLedgerEntries) {
    const invoice = await prisma.invoice.findUnique({
      where: { id: entry.referenceId },
      select: { invoiceNumber: true }
    });

    if (invoice) {
      await prisma.ledgerEntry.update({
        where: { id: entry.id },
        data: { referenceNumber: invoice.invoiceNumber }
      });
      invoiceCount++;
    }
  }
  console.log(`Updated ${invoiceCount} invoice ledger entries`);

  // Update PAYMENT ledger entries
  const paymentLedgerEntries = await prisma.ledgerEntry.findMany({
    where: { entryType: 'PAYMENT' },
    select: { id: true, referenceId: true }
  });

  let paymentCount = 0;
  for (const entry of paymentLedgerEntries) {
    const payment = await prisma.invoicePayment.findUnique({
      where: { id: entry.referenceId },
      select: { receiptNumber: true }
    });

    if (payment) {
      await prisma.ledgerEntry.update({
        where: { id: entry.id },
        data: { referenceNumber: payment.receiptNumber }
      });
      paymentCount++;
    }
  }
  console.log(`Updated ${paymentCount} payment ledger entries`);

  // Update CREDIT_NOTE ledger entries
  const creditNoteLedgerEntries = await prisma.ledgerEntry.findMany({
    where: { entryType: 'CREDIT_NOTE' },
    select: { id: true, referenceId: true }
  });

  let creditNoteCount = 0;
  for (const entry of creditNoteLedgerEntries) {
    const creditNote = await prisma.creditNote.findUnique({
      where: { id: entry.referenceId },
      select: { creditNoteNumber: true }
    });

    if (creditNote) {
      await prisma.ledgerEntry.update({
        where: { id: entry.id },
        data: { referenceNumber: creditNote.creditNoteNumber }
      });
      creditNoteCount++;
    }
  }
  console.log(`Updated ${creditNoteCount} credit note ledger entries`);

  return { invoiceCount, paymentCount, creditNoteCount };
};

/**
 * Main migration function
 */
const runMigration = async () => {
  console.log('='.repeat(60));
  console.log('Document Number Migration');
  console.log('New Format: PREFIX/DD/MM/YY-XXXX');
  console.log('='.repeat(60));

  try {
    const invoiceCount = await migrateInvoices();
    const receiptCount = await migrateReceipts();
    const creditNoteCount = await migrateCreditNotes();
    const ledgerUpdates = await updateLedgerEntries();

    console.log('\n' + '='.repeat(60));
    console.log('Migration Complete!');
    console.log('='.repeat(60));
    console.log(`Invoices migrated: ${invoiceCount}`);
    console.log(`Receipts migrated: ${receiptCount}`);
    console.log(`Credit Notes migrated: ${creditNoteCount}`);
    console.log(`Ledger entries updated: ${ledgerUpdates.invoiceCount + ledgerUpdates.paymentCount + ledgerUpdates.creditNoteCount}`);

    // Verify sequences
    const sequences = await prisma.documentSequence.findMany();
    console.log('\nDocument Sequences:');
    for (const seq of sequences) {
      console.log(`  ${seq.documentType}: ${seq.prefix} -> Last Number: ${seq.lastNumber}`);
    }

  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
};

// Run the migration
runMigration()
  .then(() => {
    console.log('\nMigration script completed successfully.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nMigration script failed:', error);
    process.exit(1);
  });
