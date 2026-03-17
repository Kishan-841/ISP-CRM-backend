/**
 * One-time migration script: Hash all plaintext customer passwords.
 *
 * Finds all leads where customerPassword is set but is not a bcrypt hash,
 * and replaces the plaintext value with a bcrypt hash.
 *
 * Usage: node prisma/hash-plaintext-passwords.js
 *
 * Safe to run multiple times — only processes non-bcrypt values.
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function hashPlaintextPasswords() {
  console.log('Finding leads with plaintext passwords...');

  const leads = await prisma.lead.findMany({
    where: {
      customerPassword: { not: null }
    },
    select: {
      id: true,
      customerUsername: true,
      customerPassword: true
    }
  });

  let hashed = 0;
  let skipped = 0;
  let errors = 0;

  for (const lead of leads) {
    // Skip if already a bcrypt hash
    if (lead.customerPassword.startsWith('$2a$') || lead.customerPassword.startsWith('$2b$')) {
      skipped++;
      continue;
    }

    try {
      const hashedPassword = await bcrypt.hash(lead.customerPassword, 10);
      await prisma.lead.update({
        where: { id: lead.id },
        data: { customerPassword: hashedPassword }
      });
      hashed++;
      console.log(`  Hashed password for: ${lead.customerUsername || lead.id}`);
    } catch (err) {
      errors++;
      console.error(`  Failed to hash for lead ${lead.id}:`, err.message);
    }
  }

  console.log(`\nDone. Total: ${leads.length}, Hashed: ${hashed}, Already hashed: ${skipped}, Errors: ${errors}`);
}

hashPlaintextPasswords()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
