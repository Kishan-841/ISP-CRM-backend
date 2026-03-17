import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DISCONNECTION_REASONS = [
  {
    name: 'Office Closed',
    sortOrder: 1,
    subCategories: ['Office Closed']
  },
  {
    name: 'Project Closed',
    sortOrder: 2,
    subCategories: ['Project Handovered/Closed']
  },
  {
    name: 'Commercial Issue',
    sortOrder: 3,
    subCategories: [
      'Moved for Better Pricing',
      'Shifted to Broadband',
      'Company in Crises/Business Downfall'
    ]
  },
  {
    name: 'Management Call',
    sortOrder: 4,
    subCategories: [
      'Shifted to Telcom (TTL/Airtel/Voda)',
      'Wants Single ISP',
      'Moved to Coworking Location'
    ]
  },
  {
    name: 'Service Issue',
    sortOrder: 5,
    subCategories: [
      'Frequent Link Down Issue',
      'IP Blacklisting Issue',
      'Link in Non Service Area/Jeopardy Location',
      'Link Shifting in Non Feasible Location',
      'Vendor/Partner Support Issue'
    ]
  }
];

async function main() {
  console.log('Seeding disconnection reason categories...');

  for (const category of DISCONNECTION_REASONS) {
    const created = await prisma.disconnectionCategory.upsert({
      where: { name: category.name },
      update: { sortOrder: category.sortOrder },
      create: {
        name: category.name,
        sortOrder: category.sortOrder,
        subCategories: {
          create: category.subCategories.map((name, idx) => ({
            name,
            sortOrder: idx + 1
          }))
        }
      }
    });
    console.log(`  ✓ ${created.name}`);
  }

  console.log('Done seeding disconnection reasons.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
