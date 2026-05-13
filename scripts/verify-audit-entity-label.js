import { entityLabelFor, AUDITED_MODELS } from '../src/audit/auditedModels.js';

const cases = [
  ['Lead',           { id: 'ld1', leadNumber: 'lead-00100', campaignData: { company: 'Acme' } }, 'Acme · lead-00100'],
  ['Lead',           { id: 'ld1', leadNumber: 'lead-00101' }, 'lead-00101'],
  ['Invoice',        { id: 'in1', invoiceNumber: 'INV/13/05/26-0042' }, 'INV/13/05/26-0042'],
  ['User',           { id: 'u1',  name: 'Bob Sales' }, 'Bob Sales'],
  ['ServiceOrder',   { id: 'so1', orderNumber: 'SO/13/05/26-0019' }, 'SO/13/05/26-0019'],
  ['CampaignData',           { id: 'cd1', company: 'Acme Inc', name: 'John Doe', phone: '9999' }, 'Acme Inc'],
  ['CampaignData',           { id: 'cd2', phone: '8888' }, '8888'],
  ['ComplaintAttachment',    { id: 'a1', fileName: 'screenshot.png' }, 'screenshot.png'],
  ['ComplaintAttachment',    { id: 'a2' }, 'a2'],
  ['Campaign',  { id: 'c1', code: 'CMP-1', name: 'Spring Outbound' }, 'CMP-1 · Spring Outbound'],
  ['Campaign',  { id: 'c2', name: 'No-code campaign' }, 'No-code campaign'],
  ['Campaign',  { id: 'c3' }, 'c3'],
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
const sizeOk = AUDITED_MODELS.size === 18;
console.log(sizeOk ? '✅ model set has 18 entries' : '❌ wrong size');

process.exit(ok && sizeOk ? 0 : 1);
