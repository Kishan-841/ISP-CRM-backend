import { entityLabelFor, AUDITED_MODELS } from '../src/audit/auditedModels.js';

const cases = [
  ['Lead',           { id: 'ld1', leadNumber: 'lead-00100', campaignData: { company: 'Acme' } }, 'Acme · lead-00100'],
  ['Lead',           { id: 'ld1', leadNumber: 'lead-00101' }, 'lead-00101'],
  ['Invoice',        { id: 'in1', invoiceNumber: 'INV/13/05/26-0042' }, 'INV/13/05/26-0042'],
  ['User',           { id: 'u1',  name: 'Bob Sales' }, 'Bob Sales'],
  ['ServiceOrder',   { id: 'so1', orderNumber: 'SO/13/05/26-0019' }, 'SO/13/05/26-0019'],
  ['UnknownModel',   { id: 'x1' }, 'x1'],
];

let ok = true;
for (const [model, record, want] of cases) {
  const got = entityLabelFor(model, record);
  const eq = got === want;
  console.log(eq ? '✅' : '❌', model, '→', got, eq ? '' : `(want ${want})`);
  if (!eq) ok = false;
}

console.log('AUDITED_MODELS size:', AUDITED_MODELS.size, AUDITED_MODELS.has('Lead') ? '(Lead present)' : '(missing Lead!)');
const sizeOk = AUDITED_MODELS.size === 15;
console.log(sizeOk ? '✅ model set has 15 entries' : '❌ wrong size');

process.exit(ok && sizeOk ? 0 : 1);
