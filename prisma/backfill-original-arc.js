import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function backfill() {
  console.log('Starting originalArcAmount backfill...');

  // Get all leads that have arcAmount but no originalArcAmount
  const leads = await prisma.lead.findMany({
    where: {
      arcAmount: { not: null },
      originalArcAmount: null
    },
    select: {
      id: true,
      arcAmount: true,
      planUpgrades: {
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: { previousArc: true }
      }
    }
  });

  console.log(`Found ${leads.length} leads to backfill`);

  let updated = 0;
  for (const lead of leads) {
    // Use earliest PlanUpgradeHistory.previousArc if available,
    // otherwise use current arcAmount (no changes were ever made)
    const originalArc = lead.planUpgrades.length > 0 && lead.planUpgrades[0].previousArc
      ? lead.planUpgrades[0].previousArc
      : lead.arcAmount;

    await prisma.lead.update({
      where: { id: lead.id },
      data: { originalArcAmount: originalArc }
    });
    updated++;
  }

  console.log(`Backfilled ${updated} leads`);
  await prisma.$disconnect();
}

backfill().catch((e) => {
  console.error('Backfill error:', e);
  prisma.$disconnect();
  process.exit(1);
});
