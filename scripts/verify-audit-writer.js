import prisma from '../src/config/db.js';
import { auditContext } from '../src/audit/context.js';
import { writeAuditEvent } from '../src/audit/writer.js';

const before = await prisma.auditEvent.count();

await auditContext.run({
  actorId: null, actorName: 'Verify Script', actorRole: 'SUPER_ADMIN',
  actorType: 'STAFF', ipAddress: '127.0.0.1', userAgent: 'curl/verify',
  requestId: 'rq-verify-1', routePath: '/test', httpMethod: 'POST',
}, async () => {
  // CREATE
  await writeAuditEvent({
    model: 'Lead',
    action: 'CREATE',
    after: { id: 'verify-lead-1', leadNumber: 'lead-verify-1', campaignData: { company: 'Verify Co' } },
  });
  // UPDATE
  await writeAuditEvent({
    model: 'Lead',
    action: 'UPDATE',
    before: { id: 'verify-lead-1', leadNumber: 'lead-verify-1', campaignData: { company: 'Verify Co' } },
    after:  { id: 'verify-lead-1', leadNumber: 'lead-verify-1', campaignData: { company: 'Verified Co' } },
  });
  // No-op UPDATE — should NOT create a row
  await writeAuditEvent({
    model: 'Lead', action: 'UPDATE',
    before: { id: 'verify-lead-2', leadNumber: 'x' },
    after:  { id: 'verify-lead-2', leadNumber: 'x' },
  });
});

const after = await prisma.auditEvent.count();
const inserted = after - before;
console.log(`Rows inserted: ${inserted}`);
const ok = inserted === 2;
console.log(ok ? '✅ writer creates rows correctly (and skips no-op)' : '❌ unexpected row count');

// Show the most recent
const recent = await prisma.auditEvent.findMany({
  where: { entityId: { startsWith: 'verify-lead-' } },
  orderBy: { createdAt: 'desc' },
  take: 5,
});
for (const r of recent) {
  console.log('  ', r.action, r.entityLabel, '·', r.actorName, '·', JSON.stringify(r.changes));
}

// Cleanup — this DELETE works today because we haven't applied the production
// Postgres role revocation yet. Once we do (Phase 13), this cleanup would fail.
// That's intentional — the immutability gate happens after all verifications.
await prisma.auditEvent.deleteMany({ where: { entityId: { startsWith: 'verify-lead-' } } });
await prisma.$disconnect();
process.exit(ok ? 0 : 1);
