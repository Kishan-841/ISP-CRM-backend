import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BDM_LIKE_ROLES, isBdmLikeRole, isBdmLike } from './bdmRoles.js';

test('BDM_LIKE_ROLES is exactly BDM and SAM', () => {
  assert.deepEqual([...BDM_LIKE_ROLES], ['BDM', 'SAM']);
  assert.ok(Object.isFrozen(BDM_LIKE_ROLES));
});

test('isBdmLikeRole: raw role check, no MASTER bypass', () => {
  assert.equal(isBdmLikeRole('BDM'), true);
  assert.equal(isBdmLikeRole('SAM'), true);
  for (const r of ['MASTER', 'BDM_CP', 'BDM_TEAM_LEADER', 'ISR', 'SAM_INTEGRATION', undefined, null, '']) {
    assert.equal(isBdmLikeRole(r), false, `expected false for ${r}`);
  }
});

test('isBdmLike(user): mirrors hasRole — MASTER passes', () => {
  assert.equal(isBdmLike({ role: 'BDM' }), true);
  assert.equal(isBdmLike({ role: 'SAM' }), true);
  assert.equal(isBdmLike({ role: 'MASTER' }), true);
  assert.equal(isBdmLike({ role: 'BDM_CP' }), false);
  assert.equal(isBdmLike({ role: 'BDM_TEAM_LEADER' }), false);
  assert.equal(isBdmLike(undefined), false);
});
