import { toEventType } from '../src/audit/eventTypes.js';

const cases = [
  ['Lead',          'CREATE', 'lead.create'],
  ['Lead',          'UPDATE', 'lead.update'],
  ['Lead',          'DELETE', 'lead.delete'],
  ['ServiceOrder',  'UPDATE', 'service-order.update'],
  ['VendorPurchaseOrder', 'CREATE', 'vendor-purchase-order.create'],
  ['User',          'LOGIN',  'user.login'],
  ['User',          'LOGOUT', 'user.logout'],
];

let ok = true;
for (const [model, action, want] of cases) {
  const got = toEventType(model, action);
  const eq = got === want;
  console.log(eq ? '✅' : '❌', model, action, '→', got, eq ? '' : `(want ${want})`);
  if (!eq) ok = false;
}
process.exit(ok ? 0 : 1);
