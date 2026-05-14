import prisma from '../../src/config/db.js';

console.log('Migrating in-flight service orders to new state machine…');

// 1. PENDING_APPROVAL → route by orderType
const oldApproval = await prisma.serviceOrder.findMany({
  where: { status: 'PENDING_APPROVAL' },
  select: { id: true, orderType: true },
});
let upgradeMigrated = 0, otherMigrated = 0;
for (const o of oldApproval) {
  const next = (o.orderType === 'UPGRADE' || o.orderType === 'DOWNGRADE')
    ? 'PENDING_DELIVERY_APPROVAL'
    : 'PENDING_SALES_DIRECTOR_APPROVAL';
  await prisma.serviceOrder.update({ where: { id: o.id }, data: { status: next } });
  if (next === 'PENDING_DELIVERY_APPROVAL') upgradeMigrated++;
  else otherMigrated++;
}
console.log(`  PENDING_APPROVAL: ${oldApproval.length} migrated (${upgradeMigrated} → DELIVERY, ${otherMigrated} → SALES_DIRECTOR)`);

// 2. APPROVED + DISCONNECTION → was the short-circuit pre-NOC state. New flow puts these in PENDING_DOCS_REVIEW.
const approvedDisconnections = await prisma.serviceOrder.findMany({
  where: { status: 'APPROVED', orderType: 'DISCONNECTION' },
  select: { id: true },
});
for (const o of approvedDisconnections) {
  await prisma.serviceOrder.update({ where: { id: o.id }, data: { status: 'PENDING_DOCS_REVIEW' } });
}
console.log(`  APPROVED+DISCONNECTION: ${approvedDisconnections.length} migrated to PENDING_DOCS_REVIEW`);

// 3. PENDING_SAM_ACTIVATION → PENDING_ACCOUNTS (the next stage in the new flow).
const samActivation = await prisma.serviceOrder.findMany({
  where: { status: 'PENDING_SAM_ACTIVATION' },
  select: { id: true },
});
for (const o of samActivation) {
  await prisma.serviceOrder.update({ where: { id: o.id }, data: { status: 'PENDING_ACCOUNTS' } });
}
console.log(`  PENDING_SAM_ACTIVATION: ${samActivation.length} migrated to PENDING_ACCOUNTS`);

console.log('');
console.log(`Done. Total in-flight orders migrated: ${oldApproval.length + approvedDisconnections.length + samActivation.length}`);
await prisma.$disconnect();
