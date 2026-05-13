import prisma from '../src/config/db.js';
import { auditContext } from '../src/audit/context.js';

const user = await prisma.user.findFirst();
if (!user) { console.error('No user available for ownership'); process.exit(1); }

const before = await prisma.auditEvent.count();
let testCampaignId = null;

await auditContext.run({
  actorId: null, actorName: 'Bulk Verify', actorRole: 'SUPER_ADMIN',
  actorType: 'STAFF', ipAddress: '127.0.0.1', userAgent: 'verify',
  requestId: 'rq-bulk', routePath: '/test', httpMethod: 'POST',
}, async () => {
  const camp = await prisma.campaign.findFirst();
  testCampaignId = camp?.id;
  if (!testCampaignId) return;

  // createMany: 3 CampaignData rows
  await prisma.campaignData.createMany({
    data: [
      { campaignId: testCampaignId, title: 'BULK', company: 'BULK-TEST-1', name: 'A', phone: '1111111111' },
      { campaignId: testCampaignId, title: 'BULK', company: 'BULK-TEST-2', name: 'B', phone: '2222222222' },
      { campaignId: testCampaignId, title: 'BULK', company: 'BULK-TEST-3', name: 'C', phone: '3333333333' },
    ],
  });

  // updateMany: rename all BULK-TEST rows
  await prisma.campaignData.updateMany({
    where: { company: { startsWith: 'BULK-TEST' } },
    data: { name: 'Bulk-Renamed' },
  });

  // deleteMany: clean up
  await prisma.campaignData.deleteMany({
    where: { company: { startsWith: 'BULK-TEST' } },
  });

  // upsert: insert then update
  const u1 = await prisma.campaignData.upsert({
    where: { id: 'this-id-does-not-exist-xxx' },
    create: { id: 'this-id-does-not-exist-xxx', campaignId: testCampaignId, title: 'UP', company: 'UPSERT-TEST', name: 'U', phone: '4444444444' },
    update: { name: 'U-updated' },
  });
  await prisma.campaignData.upsert({
    where: { id: u1.id },
    create: { id: u1.id, campaignId: testCampaignId, title: 'UP', company: 'UPSERT-TEST', name: 'X', phone: '4444444444' },
    update: { name: 'U-updated-twice' },
  });
  await prisma.campaignData.delete({ where: { id: u1.id } });
});

const after = await prisma.auditEvent.count();
const inserted = after - before;
console.log(`Total rows inserted: ${inserted}`);

// Expected:
//   3 CREATE from createMany
//   3 UPDATE from updateMany
//   3 DELETE from deleteMany
//   1 CREATE + 1 UPDATE from the two upserts
//   1 DELETE from the final cleanup of upsert row
//   = 12
const ok = inserted === 12;
console.log(ok ? '✅ bulk ops produced 12 audit rows as expected' : `❌ expected 12, got ${inserted}`);

const rows = await prisma.auditEvent.findMany({
  where: { entityType: 'CampaignData', entityLabel: { in: ['BULK-TEST-1', 'BULK-TEST-2', 'BULK-TEST-3', 'UPSERT-TEST'] } },
  orderBy: { createdAt: 'asc' },
  select: { action: true, entityLabel: true, changes: true },
});
for (const r of rows) {
  console.log(' ', r.action, '·', r.entityLabel, r.changes ? `· diff[${r.changes.length}]` : '');
}

// Cleanup audit rows
await prisma.auditEvent.deleteMany({
  where: { entityType: 'CampaignData', entityLabel: { in: ['BULK-TEST-1', 'BULK-TEST-2', 'BULK-TEST-3', 'UPSERT-TEST'] } },
});
await prisma.$disconnect();
process.exit(ok ? 0 : 1);
