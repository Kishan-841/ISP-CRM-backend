import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCancellation } from './cancelDeliveryLead.js';

const lead = (over = {}) => ({
  id: 'lead-1',
  deliveryRequests: [],
  invoices: [],
  ...over
});

test('collects every assigned serial not already returned', () => {
  const plan = planCancellation(lead({
    deliveryRequests: [{
      id: 'dr-1', status: 'ASSIGNED',
      items: [
        { id: 'i1', productId: 'p1', assignedSerialNumbers: ['A', 'B'], returnedSerialNumbers: ['B'], assignedFromPOItemId: 'b1' },
        { id: 'i2', productId: 'p2', assignedSerialNumbers: ['C'], returnedSerialNumbers: [], assignedFromPOItemId: null }
      ]
    }]
  }));
  assert.deepEqual(plan.serials.map(s => s.serialNumber), ['A', 'C']);
  assert.equal(plan.serials[0].productId, 'p1');
  assert.equal(plan.serials[0].deliveryItem.id, 'i1');
});

test('a lead with no delivery request at all plans cleanly', () => {
  const plan = planCancellation(lead());
  assert.deepEqual(plan.serials, []);
  assert.deepEqual(plan.requestIds, []);
  assert.deepEqual(plan.invoiceIds, []);
});

test('a lead with a request but no assigned items plans cleanly', () => {
  const plan = planCancellation(lead({
    deliveryRequests: [{ id: 'dr-1', status: 'PENDING_APPROVAL', items: [] }]
  }));
  assert.deepEqual(plan.serials, []);
  assert.deepEqual(plan.requestIds, ['dr-1']);
});

test('voids only open requests', () => {
  const plan = planCancellation(lead({
    deliveryRequests: [
      { id: 'open-1', status: 'PENDING_APPROVAL', items: [] },
      { id: 'open-2', status: 'APPROVED', items: [] },
      { id: 'open-3', status: 'ASSIGNED', items: [] },
      { id: 'open-4', status: 'DISPATCHED', items: [] },
      { id: 'done', status: 'COMPLETED', items: [] },
      { id: 'rejected', status: 'REJECTED', items: [] }
    ]
  }));
  assert.deepEqual(plan.requestIds, ['open-1', 'open-2', 'open-3', 'open-4']);
});

test('material from a DISPATCHED request is still returned', () => {
  // The hardware is physically out, but the lead is dead - the user chose to
  // release the stock immediately rather than hold it in an approval queue.
  const plan = planCancellation(lead({
    deliveryRequests: [{
      id: 'dr-1', status: 'DISPATCHED',
      items: [{ id: 'i1', productId: 'p1', assignedSerialNumbers: ['X'], returnedSerialNumbers: [], assignedFromPOItemId: 'b1' }]
    }]
  }));
  assert.deepEqual(plan.serials.map(s => s.serialNumber), ['X']);
});

test('closes unpaid invoices and leaves paid and cancelled ones alone', () => {
  const plan = planCancellation(lead({
    invoices: [
      { id: 'inv-generated', status: 'GENERATED' },
      { id: 'inv-partial', status: 'PARTIALLY_PAID' },
      { id: 'inv-overdue', status: 'OVERDUE' },
      { id: 'inv-draft', status: 'DRAFT' },
      { id: 'inv-sent', status: 'PAID' },
      { id: 'inv-void', status: 'CANCELLED' }
    ]
  }));
  assert.deepEqual(plan.invoiceIds, ['inv-generated', 'inv-partial', 'inv-overdue', 'inv-draft']);
});

test('serials are deduplicated across items', () => {
  // Defensive: the same serial should never be on two items, but if bad data
  // puts it there, stock must not be credited twice.
  const plan = planCancellation(lead({
    deliveryRequests: [{
      id: 'dr-1', status: 'ASSIGNED',
      items: [
        { id: 'i1', productId: 'p1', assignedSerialNumbers: ['DUP'], returnedSerialNumbers: [], assignedFromPOItemId: null },
        { id: 'i2', productId: 'p1', assignedSerialNumbers: ['DUP'], returnedSerialNumbers: [], assignedFromPOItemId: null }
      ]
    }]
  }));
  assert.equal(plan.serials.length, 1);
});

test('bulk material is listed, not returned', () => {
  // Fiber and other `mtrs` items carry no serial, so the lead they came from
  // cannot be verified and they are not credited back to stock. They are
  // reported so the store knows there is something to reconcile by hand.
  const plan = planCancellation(lead({
    deliveryRequests: [{
      id: 'dr-1', status: 'ASSIGNED',
      items: [
        { id: 'fiber', productId: 'p-fiber', assignedSerialNumbers: [], returnedSerialNumbers: [], assignedQuantity: 250 },
        { id: 'sfp', productId: 'p-sfp', assignedSerialNumbers: ['S1'], returnedSerialNumbers: [], assignedQuantity: 1 }
      ]
    }]
  }));
  assert.deepEqual(plan.serials.map(s => s.serialNumber), ['S1']);
  assert.deepEqual(plan.bulkItems, [{ itemId: 'fiber', productId: 'p-fiber', quantity: 250 }]);
});

test('an item with neither serials nor quantity is not reported as bulk', () => {
  const plan = planCancellation(lead({
    deliveryRequests: [{
      id: 'dr-1', status: 'APPROVED',
      items: [{ id: 'empty', productId: 'p1', assignedSerialNumbers: [], returnedSerialNumbers: [], assignedQuantity: 0 }]
    }]
  }));
  assert.deepEqual(plan.bulkItems, []);
});
