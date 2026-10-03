import { test } from 'node:test';
import assert from 'node:assert/strict';
import { returnSerialToStock, isSerialInStock } from './materialReturn.service.js';

/**
 * Minimal stand-in for a Prisma transaction client. Holds batches in an array
 * and records every write so tests can assert on the resulting stock state.
 */
function makeTx(batches = []) {
  const state = { batches: batches.map(b => ({ ...b })), created: [], updates: [] };
  return {
    state,
    storePurchaseOrderItem: {
      findFirst: async ({ where }) => {
        return state.batches.find(b => {
          if (where.id && b.id !== where.id) return false;
          if (where.productId && b.productId !== where.productId) return false;
          if (where.status && b.status !== where.status) return false;
          if (where.poId === null && b.poId !== null) return false;
          if (where.serialNumbers?.has && !b.serialNumbers.includes(where.serialNumbers.has)) return false;
          return true;
        }) || null;
      },
      create: async ({ data }) => {
        const batch = { id: `new-batch-${state.created.length + 1}`, ...data };
        state.batches.push(batch);
        state.created.push(batch);
        return batch;
      },
      update: async ({ where, data }) => {
        const batch = state.batches.find(b => b.id === where.id);
        Object.assign(batch, data);
        state.updates.push({ id: where.id, data });
        return batch;
      }
    }
  };
}

const item = { id: 'item-1', assignedFromPOItemId: 'batch-origin' };

test('GOOD serial goes back to its originating batch', async () => {
  const tx = makeTx([
    { id: 'batch-origin', productId: 'p1', poId: 'po1', status: 'IN_STORE', serialNumbers: ['A'], quantity: 1, receivedQuantity: 1 }
  ]);
  const batchId = await returnSerialToStock(tx, {
    deliveryItem: item, productId: 'p1', serialNumber: 'B', condition: 'GOOD', userId: 'u1'
  });
  assert.equal(batchId, 'batch-origin');
  const batch = tx.state.batches.find(b => b.id === 'batch-origin');
  assert.deepEqual(batch.serialNumbers, ['A', 'B']);
  assert.equal(batch.quantity, 2);
  assert.equal(batch.receivedQuantity, 2);
});

test('counts always equal the serial array length', async () => {
  const tx = makeTx([
    { id: 'batch-origin', productId: 'p1', poId: 'po1', status: 'IN_STORE', serialNumbers: ['A', 'C'], quantity: 99, receivedQuantity: 0 }
  ]);
  await returnSerialToStock(tx, { deliveryItem: item, productId: 'p1', serialNumber: 'B', condition: 'GOOD', userId: 'u1' });
  const batch = tx.state.batches[0];
  assert.equal(batch.quantity, batch.serialNumbers.length);
  assert.equal(batch.receivedQuantity, batch.serialNumbers.length);
});

test('a serial already in the batch is not duplicated', async () => {
  const tx = makeTx([
    { id: 'batch-origin', productId: 'p1', poId: 'po1', status: 'IN_STORE', serialNumbers: ['A', 'B'], quantity: 2, receivedQuantity: 2 }
  ]);
  await returnSerialToStock(tx, { deliveryItem: item, productId: 'p1', serialNumber: 'B', condition: 'GOOD', userId: 'u1' });
  const batch = tx.state.batches[0];
  assert.deepEqual(batch.serialNumbers, ['A', 'B'], 'must not invent inventory');
  assert.equal(batch.quantity, 2);
});

test('falls back to a PO-less IN_STORE batch when the origin is unusable', async () => {
  // Origin batch is FAULTY, so it must not be credited.
  const tx = makeTx([
    { id: 'batch-origin', productId: 'p1', poId: 'po1', status: 'FAULTY', serialNumbers: [], quantity: 0, receivedQuantity: 0 },
    { id: 'batch-loose', productId: 'p1', poId: null, status: 'IN_STORE', serialNumbers: [], quantity: 0, receivedQuantity: 0 }
  ]);
  const batchId = await returnSerialToStock(tx, {
    deliveryItem: item, productId: 'p1', serialNumber: 'B', condition: 'GOOD', userId: 'u1'
  });
  assert.equal(batchId, 'batch-loose');
});

test('creates a PO-less batch when nothing suitable exists', async () => {
  const tx = makeTx([]);
  const batchId = await returnSerialToStock(tx, {
    deliveryItem: { id: 'i', assignedFromPOItemId: null }, productId: 'p1', serialNumber: 'B', condition: 'GOOD', userId: 'u1'
  });
  assert.equal(tx.state.created.length, 1);
  assert.equal(tx.state.created[0].poId, null);
  assert.equal(tx.state.created[0].status, 'IN_STORE');
  assert.equal(tx.state.created[0].directEntryById, 'u1');
  assert.equal(batchId, tx.state.created[0].id);
});

test('FAULTY never credits the original batch', async () => {
  const tx = makeTx([
    { id: 'batch-origin', productId: 'p1', poId: 'po1', status: 'IN_STORE', serialNumbers: ['A'], quantity: 1, receivedQuantity: 1 }
  ]);
  await returnSerialToStock(tx, { deliveryItem: item, productId: 'p1', serialNumber: 'B', condition: 'FAULTY', userId: 'u1' });
  assert.deepEqual(tx.state.batches[0].serialNumbers, ['A'], 'good serials must not be quarantined');
  assert.equal(tx.state.created[0].status, 'FAULTY');
});

test('isSerialInStock finds a serial in any batch', async () => {
  const tx = makeTx([
    { id: 'b1', productId: 'p1', poId: 'po1', status: 'IN_STORE', serialNumbers: ['A'], quantity: 1, receivedQuantity: 1 }
  ]);
  assert.equal(await isSerialInStock(tx, 'A'), true);
  assert.equal(await isSerialInStock(tx, 'ZZZ'), false);
});
