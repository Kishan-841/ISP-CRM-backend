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
await prisma.$disconnect();
process.exit(ok ? 0 : 1);
