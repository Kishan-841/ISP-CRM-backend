import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { seedNexusKnowledge } from './seeds/nexus-knowledge.js';
import { seedNexusCache } from './seeds/nexus-cache.js';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Create Super Admin accounts. Both upserts use `update: {}` so re-running
  // the seed on prod NEVER overwrites a password that's been changed since
  // first creation — only the initial create branch sets the password.
  const hashedPassword = await bcrypt.hash('admin123', 10);

  const superAdmins = [
    { email: 'admin@ispcrm.com',     name: 'Super Admin' },
    { email: 'paras@gazonindia.com', name: 'Paras' },
  ];

  for (const u of superAdmins) {
    const created = await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        email: u.email,
        password: hashedPassword,
        name: u.name,
        role: 'SUPER_ADMIN',
        isActive: true,
      },
    });
    console.log('Super Admin upserted:', { email: created.email, name: created.name, role: created.role });
  }

  console.log('\n=================================');
  console.log('Super Admin Credentials (initial — change on first login):');
  superAdmins.forEach(u => console.log(`  ${u.email}  /  admin123`));
  console.log('=================================\n');

  await seedComplaintCategories();
  await seedNexusKnowledge(prisma);
  await seedNexusCache(prisma);
}

async function seedComplaintCategories() {
  console.log('\nSeeding complaint categories...');

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
      update: {},
      create: {
        name: cat.name,
      }
    });

    for (const sub of cat.subCategories) {
      await prisma.complaintSubCategory.upsert({
        where: {
          categoryId_name: { categoryId: category.id, name: sub.name }
        },
        update: { defaultTATHours: sub.defaultTATHours },
        create: {
          categoryId: category.id,
          name: sub.name,
          defaultTATHours: sub.defaultTATHours,
        }
      });
    }

    console.log(`  Category: ${cat.name} (${cat.subCategories.length} sub-categories)`);
  }

  console.log('Complaint categories seeded successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
