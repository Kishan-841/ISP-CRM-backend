import prisma from '../src/config/db.js';
import { auditContext } from '../src/audit/context.js';

const before = await prisma.auditEvent.count();

// Vendor.createdBy is required — grab any existing user to satisfy the FK.
const anyUser = await prisma.user.findFirst({ select: { id: true } });
if (!anyUser) {
  console.error('No users in DB — cannot create a Vendor for verification.');
  process.exit(1);
}

await auditContext.run({
  actorId: null, actorName: 'Ext Verify', actorRole: 'SUPER_ADMIN',
  actorType: 'STAFF', ipAddress: '127.0.0.1', userAgent: 'curl',
  requestId: 'rq-ext-1', routePath: '/test', httpMethod: 'POST',
}, async () => {
  // Vendor is small + standalone — use it as the test entity.
  const v = await prisma.vendor.create({
    data: {
      companyName: 'AUDIT-VERIFY-VENDOR',
      category: 'FIBER',
      approvalStatus: 'PENDING_ADMIN',
      createdById: anyUser.id,
    },
  });
  await prisma.vendor.update({
    where: { id: v.id },
    data: { companyName: 'AUDIT-VERIFY-VENDOR-RENAMED' },
  });
  await prisma.vendor.delete({ where: { id: v.id } });
});

const after = await prisma.auditEvent.count();
const inserted = after - before;
console.log(`Rows inserted: ${inserted}`);
const ok = inserted === 3;   // CREATE + UPDATE + DELETE
console.log(ok ? '✅ extension audits CRUD automatically' : '❌ wrong count');

// Show the rows for sanity
const recent = await prisma.auditEvent.findMany({
  where: { entityLabel: { contains: 'AUDIT-VERIFY-VENDOR' } },
  orderBy: { createdAt: 'asc' },
});
for (const r of recent) {
  console.log('  ', r.action, '·', r.entityLabel, '·', r.actorName,
              r.changes ? '·' + JSON.stringify(r.changes) : '');
}

// Cleanup
await prisma.auditEvent.deleteMany({ where: { entityLabel: { contains: 'AUDIT-VERIFY-VENDOR' } } });
await prisma.$disconnect();
process.exit(ok ? 0 : 1);
