import { computeDiff } from '../src/audit/diff.js';

const cases = [
  { name: 'simple value change',
    before: { name: 'Acme', phone: '111' },
    after:  { name: 'Acme Corp', phone: '111' },
    want:   [{ field: 'name', oldValue: 'Acme', newValue: 'Acme Corp' }] },
  { name: 'multiple changes',
    before: { name: 'A', phone: '111', city: 'X' },
    after:  { name: 'B', phone: '222', city: 'X' },
    want:   [
      { field: 'name', oldValue: 'A', newValue: 'B' },
      { field: 'phone', oldValue: '111', newValue: '222' },
    ] },
  { name: 'no changes',
    before: { name: 'A' }, after: { name: 'A' }, want: [] },
  { name: 'null vs missing treated equal',
    before: { name: 'A', note: null }, after: { name: 'A' }, want: [] },
  { name: 'skip non-data fields',
    before: { name: 'A', updatedAt: new Date(0), createdAt: new Date(0) },
    after:  { name: 'A', updatedAt: new Date(1), createdAt: new Date(0) },
    want:   [] },
];

let ok = true;
for (const c of cases) {
  const got = computeDiff(c.before, c.after);
  const eq = JSON.stringify(got) === JSON.stringify(c.want);
  console.log(eq ? '✅' : '❌', c.name);
  if (!eq) { console.log('  want:', c.want); console.log('  got: ', got); ok = false; }
}
process.exit(ok ? 0 : 1);
