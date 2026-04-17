import prisma from '../src/config/db.js';

async function main() {
  // Find a user to attribute the entries to (any active user will do)
  const user = await prisma.user.findFirst({
    where: { isActive: true, role: { in: ['STORE_MANAGER', 'SUPER_ADMIN', 'ADMIN'] } }
  });
  if (!user) {
    console.error('No active STORE_MANAGER/SUPER_ADMIN/ADMIN user found. Seed aborted.');
    process.exit(1);
  }

  const products = await prisma.storeProduct.findMany({ where: { isActive: true } });
  if (products.length === 0) {
    console.error('No active store products found. Create products first.');
    process.exit(1);
  }

  console.log(`Found ${products.length} active products. Seeding inventory…\n`);

  const makeSerials = (prefix, count) =>
    Array.from({ length: count }, (_, i) => `${prefix}-${String(i + 1).padStart(4, '0')}`);

  let createdCount = 0;
  for (const product of products) {
    const isBulk = product.category === 'FIBER' || product.unit === 'mtrs';

    // Skip if this product already has IN_STORE inventory
    const existing = await prisma.storePurchaseOrderItem.count({
      where: { productId: product.id, status: 'IN_STORE' }
    });
    if (existing > 0) {
      console.log(`⏭  ${product.modelNumber} already has inventory, skipping`);
      continue;
    }

    if (isBulk) {
      await prisma.storePurchaseOrderItem.create({
        data: {
          productId: product.id,
          quantity: 1000,
          receivedQuantity: 1000,
          serialNumbers: [],
          unitPrice: product.price || 50,
          status: 'IN_STORE',
          addedToStoreAt: new Date(),
          directEntryById: user.id
        }
      });
      console.log(`✓ ${product.modelNumber} — 1000 ${product.unit} (bulk)`);
      createdCount++;
    } else {
      const prefix = product.modelNumber.replace(/\s+/g, '').toUpperCase().slice(0, 8);
      const serials = makeSerials(prefix, 10);
      await prisma.storePurchaseOrderItem.create({
        data: {
          productId: product.id,
          quantity: 10,
          receivedQuantity: 10,
          serialNumbers: serials,
          unitPrice: product.price || 1000,
          status: 'IN_STORE',
          addedToStoreAt: new Date(),
          directEntryById: user.id
        }
      });
      console.log(`✓ ${product.modelNumber} — 10 units (serials: ${serials[0]} … ${serials[9]})`);
      createdCount++;
    }
  }

  console.log(`\nDone. Created ${createdCount} inventory entries.`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
