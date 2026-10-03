import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canCancelLead, CANCELLABLE_STAGES } from './leadCancellation.js';

const base = {
  id: 'lead-1',
  pushedToInstallationAt: new Date('2026-09-01'),
  cancelledAt: null,
  customerAcceptanceAt: null,
  customerAcceptanceStatus: null,
  actualPlanIsActive: false
};

test('allows a lead sitting in delivery with a reason', () => {
  const r = canCancelLead(base, 'Customer backed out');
  assert.equal(r.allowed, true);
  assert.equal(r.code, null);
});

test('refuses a lead that never reached delivery', () => {
  const r = canCancelLead({ ...base, pushedToInstallationAt: null }, 'x');
  assert.equal(r.allowed, false);
  assert.equal(r.code, 'NOT_IN_DELIVERY');
});

test('refuses an already-cancelled lead (guards double submission)', () => {
  const r = canCancelLead({ ...base, cancelledAt: new Date() }, 'x');
  assert.equal(r.allowed, false);
  assert.equal(r.code, 'ALREADY_CANCELLED');
});

test('refuses once customer acceptance is recorded', () => {
  const r = canCancelLead({ ...base, customerAcceptanceAt: new Date() }, 'x');
  assert.equal(r.allowed, false);
  assert.equal(r.code, 'ACCEPTANCE_RECORDED');
});

test('refuses when acceptance status is ACCEPTED even without a timestamp', () => {
  const r = canCancelLead({ ...base, customerAcceptanceStatus: 'ACCEPTED' }, 'x');
  assert.equal(r.allowed, false);
  assert.equal(r.code, 'ACCEPTANCE_RECORDED');
});

test('allows when acceptance was REJECTED - the lead is still live work', () => {
  const r = canCancelLead({ ...base, customerAcceptanceStatus: 'REJECTED' }, 'x');
  assert.equal(r.allowed, true);
});

test('refuses when a plan is active', () => {
  const r = canCancelLead({ ...base, actualPlanIsActive: true }, 'x');
  assert.equal(r.allowed, false);
  assert.equal(r.code, 'PLAN_ACTIVE');
});

test('refuses a blank or whitespace-only reason', () => {
  for (const reason of ['', '   ', '\n\t', undefined, null]) {
    const r = canCancelLead(base, reason);
    assert.equal(r.allowed, false, `expected refusal for ${JSON.stringify(reason)}`);
    assert.equal(r.code, 'REASON_REQUIRED');
  }
});

test('acceptance is checked before reason - the harder stop wins', () => {
  const r = canCancelLead({ ...base, customerAcceptanceAt: new Date() }, '');
  assert.equal(r.code, 'ACCEPTANCE_RECORDED');
});

test('a null lead is refused, not thrown on', () => {
  assert.equal(canCancelLead(null, 'x').allowed, false);
  assert.equal(canCancelLead(undefined, 'x').code, 'NOT_IN_DELIVERY');
});

test('cancellation is permitted regardless of which delivery user owns the lead', () => {
  // Ownership is not a guard condition - the actor is recorded in
  // cancelledById by the controller, and admins reassign leads freely.
  const r = canCancelLead({ ...base, deliveryAssignedToId: 'someone-else' }, 'x');
  assert.equal(r.allowed, true);
});

test('CANCELLABLE_STAGES is frozen and ends at customer_acceptance', () => {
  assert.ok(Object.isFrozen(CANCELLABLE_STAGES));
  assert.equal(CANCELLABLE_STAGES.at(-1), 'customer_acceptance');
  for (const dead of ['completed', 'cancelled', 'rejected']) {
    assert.equal(CANCELLABLE_STAGES.includes(dead), false, `${dead} must not be cancellable`);
  }
});
