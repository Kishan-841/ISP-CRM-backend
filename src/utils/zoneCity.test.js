import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkZoneCity } from './zoneCity.js';

const city = (over = {}) => ({
  id: 'city-1',
  zoneId: 'zone-pune',
  name: 'Pune- Chakan',
  isActive: true,
  ...over,
});

test('accepts a city that belongs to the chosen zone', () => {
  assert.deepEqual(checkZoneCity('zone-pune', 'city-1', city()), { ok: true });
});

test('rejects a city from a different zone', () => {
  // The case that matters: a stale dropdown, or a hand-rolled API call,
  // pairing Walunj with Pune. SAM would show the wrong circle and nobody
  // would spot it.
  const res = checkZoneCity('zone-nashik', 'city-1', city());
  assert.equal(res.ok, false);
  assert.match(res.message, /does not belong/);
});

test('rejects a retired city for a new selection', () => {
  const res = checkZoneCity('zone-pune', 'city-1', city({ isActive: false }));
  assert.equal(res.ok, false);
  assert.match(res.message, /no longer available/);
});

test('rejects a city id that does not resolve', () => {
  const res = checkZoneCity('zone-pune', 'city-gone', null);
  assert.equal(res.ok, false);
  assert.match(res.message, /not found/);
});

test('requires the zone', () => {
  assert.deepEqual(checkZoneCity(null, 'city-1', city()), {
    ok: false,
    message: 'Zone is required.',
  });
});

test('requires the city', () => {
  assert.deepEqual(checkZoneCity('zone-pune', null, null), {
    ok: false,
    message: 'City is required.',
  });
});
