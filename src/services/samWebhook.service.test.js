import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload } from './samWebhook.service.js';

const lead = (over = {}) => ({
  id: 'lead-uuid-1',
  leadNumber: 'GAZ-1535',
  circuitId: '1101462',
  actualPlanName: 'lcssl_mohammed_wadi_100mbps',
  actualPlanBandwidth: 100,
  actualPlanPrice: 14166,
  actualPlanStartDate: new Date('2026-10-13T00:00:00.000Z'),
  arcAmount: 170000,
  customerUsername: 'dwl_undri',
  customerGstNo: '27AAIFD5398J1ZV',
  installationAddress: 'Plot 14, Mundhwa Industrial Estate',
  fullAddress: 'Head office, Koregaon Park',
  billingAddress: 'Accounts dept, Koregaon Park',
  customerIpAddresses: ['103.21.58.10', '103.21.58.11'],
  customerIpAssigned: '103.21.58.10',
  campaignData: {
    company: 'The LeadCrafters',
    name: 'abrar',
    email: 'abrar@theleadcrafters.com',
    phone: '8999353720',
    city: 'Pune',
    industry: 'IT',
  },
  ...over,
});

const customer = (over) => buildPayload(lead(over)).customer;

test('sends the lead number under both leadId and leadNumber', () => {
  // leadId is the key SAM's accounts.lead_id binds to; leadNumber is kept
  // only so an older SAM build keeps working through the cutover.
  const c = customer();
  assert.equal(c.leadId, 'GAZ-1535');
  assert.equal(c.leadNumber, 'GAZ-1535');
});

test('externalId stays the lead UUID, not the lead number', () => {
  // SAM upserts accounts on externalCrmId. leadNumber is nullable in our
  // schema, so using it as the key would collide across unnumbered leads.
  const c = customer();
  assert.equal(c.externalId, 'lead-uuid-1');
});

test('carries the NOC-assigned username', () => {
  assert.equal(customer().userName, 'dwl_undri');
});

test('contact person is sent separately from the client name', () => {
  // SAM derives clientName from contactName but renders contactPersonName
  // on its Contact card. Sending only the former left that card blank.
  const c = customer();
  assert.equal(c.contactName, 'abrar');
  assert.equal(c.contactPersonName, 'abrar');
});

test('address prefers the installation address', () => {
  assert.equal(customer().address, 'Plot 14, Mundhwa Industrial Estate');
});

test('address falls back to fullAddress, then billingAddress', () => {
  assert.equal(
    customer({ installationAddress: null }).address,
    'Head office, Koregaon Park'
  );
  assert.equal(
    customer({ installationAddress: null, fullAddress: '   ' }).address,
    'Accounts dept, Koregaon Park'
  );
});

test('a blank address becomes null rather than an empty string', () => {
  // SAM's rule is "overwrite only when the CRM actually has a value".
  // An empty string would read as a value and blank out what SAM holds.
  const c = customer({ installationAddress: '  ', fullAddress: '', billingAddress: null });
  assert.equal(c.address, null);
});

test('business details map across', () => {
  const c = customer();
  assert.equal(c.city, 'Pune');
  assert.equal(c.gstNumber, '27AAIFD5398J1ZV');
  assert.equal(c.industryType, 'IT');
});

test('multiple IPs collapse into one comma-separated string', () => {
  // SAM keeps ip_details as free text, not a modelled list.
  assert.equal(customer().ipDetails, '103.21.58.10, 103.21.58.11');
});

test('IP details fall back to the legacy single-IP column', () => {
  assert.equal(
    customer({ customerIpAddresses: null }).ipDetails,
    '103.21.58.10'
  );
});

test('IP details ignore blank entries in the array', () => {
  const c = customer({ customerIpAddresses: ['', '  ', '103.21.58.12'] });
  assert.equal(c.ipDetails, '103.21.58.12');
});

test('no IPs at all sends null', () => {
  const c = customer({ customerIpAddresses: [], customerIpAssigned: null });
  assert.equal(c.ipDetails, null);
});

test('zone sends null until the CRM grows the field', () => {
  // The path is wired end to end; only the source field is missing.
  assert.equal(customer().circle, null);
});

test('zone flows the moment a lead carries one', () => {
  assert.equal(customer({ zone: 'Mundhwa' }).circle, 'Mundhwa');
});

test('a lead with no campaign data does not throw', () => {
  const c = customer({ campaignData: null });
  assert.equal(c.companyName, null);
  assert.equal(c.city, null);
  assert.equal(c.industryType, null);
});

test('the ARC and plan fields are untouched by this change', () => {
  const c = customer();
  assert.equal(c.currentArc, 170000);
  assert.equal(c.currentMrr, 14166);
  assert.equal(c.bandwidthMbps, 100);
  assert.equal(c.onboardingDate, '2026-10-13');
  assert.equal(c.circuitId, '1101462');
});
