import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLeadPayload, isConfigured, SYNC_CURSOR_KEY } from './mspCrm.service.js';

const lead = (over = {}) => ({
  id: 'lead-uuid-1',
  leadNumber: 'lead-00042',
  requirements: 'Needs 2 firewalls',
  customerGstNo: '27AAACA4321P1Z3',
  billingAddress: 'Pune',
  bandwidthRequirement: '100 Mbps',
  campaignData: {
    company: 'Acme Pvt Ltd',
    name: 'Ravi Kumar',
    phone: '+91 98765 43210',
    email: 'ravi@acme.com',
    state: 'Maharashtra',
    city: 'Pune',
  },
  ...over,
});

const user = { id: 'u1', name: 'Sam User', email: 'sam@example.com' };

test('externalRef is the lead id, never the lead number', () => {
  // leadNumber is nullable in our schema; their field must always be present
  // and unique, so sending it would break on any lead that lacks one.
  const { payload } = buildLeadPayload(lead(), user);
  assert.equal(payload.externalRef, 'lead-uuid-1');
  assert.notEqual(payload.externalRef, 'lead-00042');
});

test('externalRef survives a lead with no lead number', () => {
  const { payload, missing } = buildLeadPayload(lead({ leadNumber: null }), user);
  assert.equal(payload.externalRef, 'lead-uuid-1');
  assert.deepEqual(missing, []);
});

test('maps the four required fields from campaignData', () => {
  const { payload, missing } = buildLeadPayload(lead(), user);
  assert.equal(payload.companyName, 'Acme Pvt Ltd');
  assert.equal(payload.contactPerson, 'Ravi Kumar');
  assert.equal(payload.phone, '+91 98765 43210');
  assert.equal(payload.email, 'ravi@acme.com');
  assert.deepEqual(missing, []);
});

test('reports each missing required field by name', () => {
  const { missing } = buildLeadPayload(
    lead({ campaignData: { company: 'Acme Pvt Ltd', name: 'Ravi', phone: null, email: null } }),
    user
  );
  assert.deepEqual(missing.sort(), ['email', 'phone']);
});

test('a lead with no campaignData at all is reported, not thrown on', () => {
  const { payload, missing } = buildLeadPayload(lead({ campaignData: null }), user);
  assert.equal(payload.externalRef, 'lead-uuid-1');
  assert.deepEqual(missing.sort(), ['companyName', 'contactPerson', 'email', 'phone']);
});

test('falls back to firstName + lastName when name is absent', () => {
  const { payload, missing } = buildLeadPayload(
    lead({ campaignData: { company: 'Acme', firstName: 'Ravi', lastName: 'Kumar', phone: '1', email: 'a@b.c' } }),
    user
  );
  assert.equal(payload.contactPerson, 'Ravi Kumar');
  assert.deepEqual(missing, []);
});

test('whitespace-only values count as missing, not as present', () => {
  const { missing } = buildLeadPayload(
    lead({ campaignData: { company: '   ', name: '\t', phone: ' ', email: 'a@b.c' } }),
    user
  );
  assert.deepEqual(missing.sort(), ['companyName', 'contactPerson', 'phone']);
});

test('submittedBy carries the acting user, and is omitted without one', () => {
  assert.deepEqual(buildLeadPayload(lead(), user).payload.submittedBy, {
    name: 'Sam User',
    email: 'sam@example.com',
  });
  assert.equal('submittedBy' in buildLeadPayload(lead(), null).payload, false);
});

test('optional fields are omitted rather than sent as null', () => {
  // Their API treats these as optional; sending explicit nulls invites a 400
  // from a validator that distinguishes "absent" from "null".
  const { payload } = buildLeadPayload(
    lead({ requirements: null, customerGstNo: null, billingAddress: null, campaignData: {
      company: 'Acme', name: 'Ravi', phone: '1', email: 'a@b.c',
    } }),
    user
  );
  assert.equal(payload.requirement, undefined);
  assert.equal(payload.customerGstin, undefined);
  assert.equal(payload.customerState, undefined);
  assert.equal(payload.billingAddress, undefined);
});

test('billingAddress falls back to the city when no billing address is set', () => {
  const { payload } = buildLeadPayload(lead({ billingAddress: null }), user);
  assert.equal(payload.billingAddress, 'Pune');
});

test('isConfigured needs BOTH the url and the key', () => {
  const url = process.env.MSP_CRM_API_URL;
  const key = process.env.MSP_CRM_API_KEY;
  try {
    delete process.env.MSP_CRM_API_URL;
    delete process.env.MSP_CRM_API_KEY;
    assert.equal(isConfigured(), false);
    process.env.MSP_CRM_API_URL = 'https://x/api/v1/integrations';
    assert.equal(isConfigured(), false, 'url alone must not count as configured');
    process.env.MSP_CRM_API_KEY = 'k';
    assert.equal(isConfigured(), true);
  } finally {
    if (url === undefined) delete process.env.MSP_CRM_API_URL; else process.env.MSP_CRM_API_URL = url;
    if (key === undefined) delete process.env.MSP_CRM_API_KEY; else process.env.MSP_CRM_API_KEY = key;
  }
});

test('the cursor key is stable', () => {
  // The sync resumes from this key; renaming it silently re-reads all history.
  assert.equal(SYNC_CURSOR_KEY, 'msp_last_synced_at');
});
