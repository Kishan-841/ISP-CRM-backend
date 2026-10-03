import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unpaidRemainderOf } from './ledger.service.js';

test('unpaid remainder prefers the stored remainingAmount', () => {
  assert.equal(unpaidRemainderOf({ grandTotal: 1000, totalPaidAmount: 400, totalCreditAmount: 0, remainingAmount: 600 }), 600);
});

test('falls back to grandTotal minus payments and credits', () => {
  assert.equal(unpaidRemainderOf({ grandTotal: 1000, totalPaidAmount: 250, totalCreditAmount: 50, remainingAmount: null }), 700);
});

test('a partially paid invoice credits ONLY the unpaid part', () => {
  // Crediting grandTotal here would push the customer ledger negative by the
  // amount they already paid.
  assert.equal(unpaidRemainderOf({ grandTotal: 12000, totalPaidAmount: 5000, totalCreditAmount: 0, remainingAmount: 7000 }), 7000);
});

test('a fully paid invoice has nothing to reverse', () => {
  assert.equal(unpaidRemainderOf({ grandTotal: 1000, totalPaidAmount: 1000, totalCreditAmount: 0, remainingAmount: 0 }), 0);
});

test('never returns a negative remainder on an overpaid invoice', () => {
  assert.equal(unpaidRemainderOf({ grandTotal: 1000, totalPaidAmount: 1200, totalCreditAmount: 0, remainingAmount: -200 }), 0);
});

test('treats missing numeric fields as zero', () => {
  assert.equal(unpaidRemainderOf({ grandTotal: 500 }), 500);
  assert.equal(unpaidRemainderOf({}), 0);
});
