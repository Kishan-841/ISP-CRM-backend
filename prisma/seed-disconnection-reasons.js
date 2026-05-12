import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// IDs (slugs) are the SAM↔CRM bridge contract — SAM POSTs these strings
// verbatim in disconnectionCategoryId / disconnectionSubCategoryId. Do not
// rename without coordinating with the SAM team
// (docs/INTEGRATION_CRM.md in the SAM repo).
const CATEGORIES = [
  {
    id: 'office-closed',
    name: 'Office Closed',
    sortOrder: 1,
    subCategories: [
      { id: 'office-closed', name: 'Office Closed' },
    ],
  },
  {
    id: 'project-closed',
    name: 'Project Closed',
    sortOrder: 2,
    subCategories: [
      { id: 'project-handovered-closed', name: 'Project Handovered / Closed' },
    ],
  },
  {
    id: 'commercial-issue',
    name: 'Commercial Issue',
    sortOrder: 3,
    subCategories: [
      { id: 'moved-for-better-pricing', name: 'Moved for Better Pricing' },
      { id: 'shifted-to-broadband', name: 'Shifted to Broadband' },
      { id: 'company-in-crisis-business-downfall', name: 'Company in Crisis / Business Downfall' },
    ],
  },
  {
    id: 'management-call',
    name: 'Management Call',
    sortOrder: 4,
    subCategories: [
      { id: 'shifted-to-telcom', name: 'Shifted to Telcom (TTL / Airtel / Voda)' },
      { id: 'wants-single-isp', name: 'Wants Single ISP' },
      { id: 'moved-to-coworking', name: 'Moved to Coworking Location' },
    ],
  },
  {
    id: 'service-issue',
    name: 'Service Issue',
    sortOrder: 5,
    subCategories: [
      { id: 'frequent-link-down', name: 'Frequent Link Down Issue' },
      { id: 'ip-blacklisting', name: 'IP Blacklisting Issue' },
      { id: 'non-service-area', name: 'Link in Non-Service Area / Jeopardy Location' },
      { id: 'link-shifting-non-feasible', name: 'Link Shifting in Non-Feasible Location' },
      { id: 'vendor-partner-support', name: 'Vendor / Partner Support Issue' },
    ],
  },
];

async function main() {
  console.log('Seeding disconnection reason categories…');

  for (const cat of CATEGORIES) {
    await prisma.disconnectionCategory.upsert({
      where: { id: cat.id },
      update: { name: cat.name, sortOrder: cat.sortOrder, isActive: true },
      create: { id: cat.id, name: cat.name, sortOrder: cat.sortOrder, isActive: true },
    });

    for (let i = 0; i < cat.subCategories.length; i++) {
      const sub = cat.subCategories[i];
      await prisma.disconnectionSubCategory.upsert({
        where: { id: sub.id },
        update: { name: sub.name, sortOrder: i + 1, isActive: true, categoryId: cat.id },
        create: { id: sub.id, name: sub.name, sortOrder: i + 1, isActive: true, categoryId: cat.id },
      });
    }

    console.log(`  ✓ ${cat.name} (${cat.subCategories.length} sub)`);
  }

  console.log('Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
