import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Replacing complaint categories...\n');

  // Step 1: Deactivate all existing categories and subcategories
  const deactivatedCats = await prisma.complaintCategory.updateMany({
    where: { isActive: true },
    data: { isActive: false }
  });
  const deactivatedSubs = await prisma.complaintSubCategory.updateMany({
    where: { isActive: true },
    data: { isActive: false }
  });
  console.log(`Deactivated ${deactivatedCats.count} categories and ${deactivatedSubs.count} sub-categories.\n`);

  // Step 2: Create new categories with subcategories
  const categories = [
    {
      name: 'Link Down',
      subCategories: [
        { name: 'Customer End Device Issue', defaultTATHours: 4 },
        { name: 'Fiber Cut', defaultTATHours: 6 },
        { name: 'Power Issue at transit switch', defaultTATHours: 4 },
        { name: 'Customer End Power Issue', defaultTATHours: 4 },
        { name: 'Bandwidth Full Utilization', defaultTATHours: 8 },
        { name: 'Cable/Connector Issue', defaultTATHours: 6 },
        { name: 'Customer Lan Side Issue', defaultTATHours: 4 },
        { name: 'Customer premises fiber cut', defaultTATHours: 6 },
        { name: 'Device hardware faulty', defaultTATHours: 8 },
        { name: 'Fiber Loss', defaultTATHours: 6 },
      ]
    },
    {
      name: 'Speed Issue',
      subCategories: [
        { name: 'Bandwidth Full Utilization', defaultTATHours: 8 },
        { name: 'Speed Issue at LAN Side', defaultTATHours: 4 },
        { name: 'Customer End Device Issue', defaultTATHours: 4 },
        { name: 'RF Alignment Issue', defaultTATHours: 8 },
        { name: 'Speed at WAN Side', defaultTATHours: 8 },
        { name: 'RF Device Issue', defaultTATHours: 8 },
        { name: 'Customer Lan Side Issue', defaultTATHours: 4 },
      ]
    },
    {
      name: 'Packet Drop',
      subCategories: [
        { name: 'Bandwidth full Utilization', defaultTATHours: 8 },
        { name: 'Customer Lan Side Issue', defaultTATHours: 4 },
        { name: 'Customer End Device Issue', defaultTATHours: 4 },
        { name: 'Uplink Flap', defaultTATHours: 8 },
        { name: 'Link Flapping', defaultTATHours: 8 },
      ]
    },
    {
      name: 'Browsing Issue',
      subCategories: [
        { name: 'Customer Lan Side Issue', defaultTATHours: 4 },
      ]
    },
    {
      name: 'Link Flapping',
      subCategories: [
        { name: 'Customer End Device Issue', defaultTATHours: 4 },
        { name: 'Customer Lan Side Issue', defaultTATHours: 4 },
        { name: 'Device Hang Issue', defaultTATHours: 8 },
        { name: 'Bandwidth Full Utilization', defaultTATHours: 8 },
        { name: 'Uplink Flap', defaultTATHours: 8 },
        { name: 'Link Flapping', defaultTATHours: 8 },
      ]
    },
    {
      name: 'Link Shifting',
      subCategories: [
        { name: 'Link Shifting', defaultTATHours: 8 },
      ]
    },
    {
      name: 'Demo Bandwidth',
      subCategories: [
        { name: 'Demo Bandwidth Upgrade', defaultTATHours: 4 },
        { name: 'Demo Bandwidth Downgrade', defaultTATHours: 4 },
      ]
    },
    {
      name: 'Monitoring',
      subCategories: [
        { name: 'Monitoring', defaultTATHours: 8 },
      ]
    },
    {
      name: 'Maintenance Activity',
      subCategories: [
        { name: 'Maintenance Activity', defaultTATHours: 24 },
      ]
    },
    {
      name: 'Material Collection',
      subCategories: [
        { name: 'Material Collection', defaultTATHours: 24 },
      ]
    },
  ];

  for (const cat of categories) {
    const category = await prisma.complaintCategory.upsert({
      where: { name: cat.name },
      update: { isActive: true, description: null },
      create: {
        name: cat.name,
        isActive: true,
      }
    });

    for (const sub of cat.subCategories) {
      await prisma.complaintSubCategory.upsert({
        where: {
          categoryId_name: { categoryId: category.id, name: sub.name }
        },
        update: { isActive: true, defaultTATHours: sub.defaultTATHours },
        create: {
          categoryId: category.id,
          name: sub.name,
          defaultTATHours: sub.defaultTATHours,
          isActive: true,
        }
      });
    }

    console.log(`  Created: ${cat.name} (${cat.subCategories.length} sub-categories)`);
  }

  console.log('\nDone! New complaint categories are active, old ones deactivated.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
