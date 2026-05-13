import prisma from '../src/config/db.js';

const cols = await prisma.$queryRaw`
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_name = 'audit_events'
  ORDER BY ordinal_position
`;
console.table(cols);
console.log('Total columns:', cols.length);
const expected = 22;
const ok = cols.length === expected;
console.log(ok ? `✅ ${expected} columns present` : `❌ expected ${expected}, got ${cols.length}`);

const enumCols = await prisma.$queryRaw`
  SELECT column_name, udt_name
  FROM information_schema.columns
  WHERE table_name = 'audit_events' AND data_type = 'USER-DEFINED'
  ORDER BY column_name
`;
console.log('Enum-typed columns:', enumCols);
const expectedUdt = {
  action:    'AuditEventAction',
  actorType: 'AuditEventActorType',
  status:    'AuditEventStatus',
};
let enumsOk = true;
for (const [col, want] of Object.entries(expectedUdt)) {
  const row = enumCols.find(r => r.column_name === col);
  if (!row) { console.log(`❌ missing column ${col}`); enumsOk = false; continue; }
  if (row.udt_name !== want) {
    console.log(`❌ ${col} is ${row.udt_name}, want ${want}`);
    enumsOk = false;
  }
}
console.log(enumsOk ? '✅ all enum columns use the renamed types' : '❌ enum naming mismatch');

await prisma.$disconnect();
process.exit(ok && enumsOk ? 0 : 1);
