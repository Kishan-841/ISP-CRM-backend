import prisma from '../src/config/db.js';

/**
 * Phase 11 parity check.
 *
 * During the 14-day double-write observation window, both legacy audit systems
 * (StatusChangeLog + AuditLog) keep writing alongside the new AuditEvent.
 * This script — run once a day, manually or via cron — confirms every
 * legacy row from the last 24 hours has a corresponding new AuditEvent row.
 *
 * Exit 0 = clean. Exit 1 = divergence found. Use the printed MISSING list
 * to investigate before proceeding to Phase 12 cutover.
 *
 * Usage:  node scripts/audit-parity-check.js
 *         node scripts/audit-parity-check.js --since=2026-05-10T00:00:00Z
 */

const HOURS_BACK = 24;
const TIME_TOLERANCE_MS = 5_000;

const argSince = process.argv.find(a => a.startsWith('--since='));
const since = argSince
  ? new Date(argSince.split('=')[1])
  : new Date(Date.now() - HOURS_BACK * 60 * 60 * 1000);

console.log(`Parity check from ${since.toISOString()} → now`);
console.log('');

const entityTypeMap = {
  LEAD:             'Lead',
  INVOICE:          'Invoice',
  DELIVERY_REQUEST: 'DeliveryRequest',
  VENDOR:           'Vendor',
  CAMPAIGN:         'Campaign',
  CAMPAIGN_DATA:    'CampaignData',
};

function mapEntityType(s) { return entityTypeMap[s] || s; }

let totalChecked = 0;
let missing = 0;

// ─── StatusChangeLog parity ──────────────────────────────────────────────
console.log('Checking StatusChangeLog → AuditEvent…');

const statusLogs = await prisma.statusChangeLog.findMany({
  where: { changedAt: { gte: since } },
  select: { entityType: true, entityId: true, field: true, oldValue: true, newValue: true, changedAt: true, changedById: true },
  orderBy: { changedAt: 'asc' },
});

for (const s of statusLogs) {
  totalChecked++;
  const modelName = mapEntityType(s.entityType);
  const matches = await prisma.auditEvent.findMany({
    where: {
      entityType: modelName,
      entityId: s.entityId,
      action: 'UPDATE',
      createdAt: {
        gte: new Date(s.changedAt.getTime() - TIME_TOLERANCE_MS),
        lte: new Date(s.changedAt.getTime() + TIME_TOLERANCE_MS),
      },
    },
    select: { changes: true },
  });
  const found = matches.some(
    m => Array.isArray(m.changes) && m.changes.some(c => c.field === s.field),
  );
  if (!found) {
    missing++;
    console.log(`  MISSING StatusChangeLog: ${s.entityType} ${s.entityId} field=${s.field} at ${s.changedAt.toISOString()}`);
  }
}

console.log(`  StatusChangeLog: ${statusLogs.length} checked, ${missing} MISSING`);

const sclMissing = missing;
const sclChecked = statusLogs.length;
totalChecked = 0;  // reset for next section's display total
missing = 0;

// ─── AuditLog parity ────────────────────────────────────────────────────
console.log('');
console.log('Checking AuditLog → AuditEvent…');

const auditLogs = await prisma.auditLog.findMany({
  where: { createdAt: { gte: since } },
  select: { entityType: true, entityId: true, action: true, createdAt: true, userId: true },
  orderBy: { createdAt: 'asc' },
});

for (const a of auditLogs) {
  totalChecked++;
  const modelName = mapEntityType(a.entityType);
  const match = await prisma.auditEvent.findFirst({
    where: {
      entityType: modelName,
      entityId: a.entityId,
      action: a.action,
      createdAt: {
        gte: new Date(a.createdAt.getTime() - TIME_TOLERANCE_MS),
        lte: new Date(a.createdAt.getTime() + TIME_TOLERANCE_MS),
      },
    },
    select: { id: true },
  });
  if (!match) {
    missing++;
    console.log(`  MISSING AuditLog: ${a.entityType} ${a.entityId} ${a.action} at ${a.createdAt.toISOString()}`);
  }
}

console.log(`  AuditLog: ${auditLogs.length} checked, ${missing} MISSING`);

const auditMissing = missing;

// ─── Summary ────────────────────────────────────────────────────────────
console.log('');
const totalMissing = sclMissing + auditMissing;
if (totalMissing === 0) {
  console.log('✅ PARITY CLEAN');
  console.log(`   ${sclChecked} StatusChangeLog + ${auditLogs.length} AuditLog rows all have AuditEvent counterparts.`);
} else {
  console.log(`❌ PARITY DRIFT: ${totalMissing} missing AuditEvent rows`);
  console.log(`   (${sclMissing} from StatusChangeLog, ${auditMissing} from AuditLog)`);
  console.log('   Investigate above before proceeding to Phase 12 cutover.');
}

await prisma.$disconnect();
process.exit(totalMissing === 0 ? 0 : 1);
