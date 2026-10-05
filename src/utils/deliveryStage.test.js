import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLeadStage } from './deliveryStage.js';

test('cancelled wins over every other signal', () => {
  // A cancelled lead may still carry any old deliveryStatus and an open
  // request; the cancelled bucket must still claim it.
  assert.equal(getLeadStage({ cancelledAt: new Date(), deliveryStatus: 'COMPLETED' }), 'cancelled');
  assert.equal(getLeadStage({ cancelledAt: new Date(), deliveryStatus: 'INSTALLING' }), 'cancelled');
  assert.equal(getLeadStage({ deliveryStatus: 'CANCELLED' }), 'cancelled');
  assert.equal(
    getLeadStage({
      cancelledAt: new Date(),
      deliveryRequests: [{ status: 'ASSIGNED', pushedToNocAt: null }]
    }),
    'cancelled'
  );
});

test('maps each deliveryStatus to its stage', () => {
  const cases = {
    COMPLETED: 'completed',
    MATERIAL_REJECTED: 'material_rejected',
    REJECTED: 'rejected',
    CUSTOMER_ACCEPTANCE: 'customer_acceptance',
    SPEED_TEST: 'speed_test',
    DEMO_PLAN_PENDING: 'demo_plan_pending',
    INSTALLING: 'installing',
    ACTIVATION_READY: 'noc_completed',
    PUSHED_TO_NOC: 'pushed_to_noc'
  };
  for (const [status, stage] of Object.entries(cases)) {
    assert.equal(getLeadStage({ deliveryStatus: status }), stage, `${status} -> ${stage}`);
  }
});

test('MATERIAL_RECEIVED resolves to material_received', () => {
  // The old backend copy omitted this and let it fall through to the request
  // branch, disagreeing with the frontend. Pinned here so it cannot regress.
  assert.equal(getLeadStage({ deliveryStatus: 'MATERIAL_RECEIVED' }), 'material_received');
});

test('falls back to the active delivery request', () => {
  assert.equal(
    getLeadStage({ deliveryRequests: [{ status: 'ASSIGNED', pushedToNocAt: null }] }),
    'material_received'
  );
  assert.equal(
    getLeadStage({ deliveryRequests: [{ status: 'ASSIGNED', pushedToNocAt: new Date() }] }),
    'pushed_to_noc'
  );
  assert.equal(getLeadStage({ deliveryRequests: [{ status: 'PENDING_APPROVAL' }] }), 'material_requested');
  assert.equal(getLeadStage({ deliveryRequests: [{ status: 'APPROVED' }] }), 'material_requested');
});

test('a CANCELLED request does not place the lead in a material bucket', () => {
  assert.equal(
    getLeadStage({ deliveryRequests: [{ status: 'CANCELLED' }], deliveryVendorSetupDone: true }),
    'pending'
  );
});

test('vendor setup when not done, pending otherwise', () => {
  assert.equal(getLeadStage({ deliveryVendorSetupDone: false }), 'vendor_setup');
  assert.equal(getLeadStage({ deliveryVendorSetupDone: true }), 'pending');
  assert.equal(getLeadStage({}), 'vendor_setup');
});
