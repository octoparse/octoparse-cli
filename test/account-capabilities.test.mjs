import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CNAccountType,
  resolveCNLocalRunPolicy
} from '../dist/runtime/account-capabilities.js';

test('CN local run policy uses currentAccountLevel as effective level', () => {
  assert.deepEqual(
    resolveCNLocalRunPolicy({
      currentAccountLevel: CNAccountType.Free,
      type: CNAccountType.Group
    }),
    {
      accountLevel: CNAccountType.Free,
      maxActiveLocalRuns: 2
    }
  );
});

test('CN free and personal accounts have local run concurrency limits', () => {
  assert.equal(resolveCNLocalRunPolicy({ currentAccountLevel: CNAccountType.Free }).maxActiveLocalRuns, 2);
  assert.equal(resolveCNLocalRunPolicy({ currentAccountLevel: CNAccountType.Personal }).maxActiveLocalRuns, 3);
});

test('CN team and enterprise accounts are not limited by the local CLI gate', () => {
  assert.equal(resolveCNLocalRunPolicy({ currentAccountLevel: CNAccountType.Group }).maxActiveLocalRuns, null);
  assert.equal(resolveCNLocalRunPolicy({ currentAccountLevel: CNAccountType.Business }).maxActiveLocalRuns, null);
  assert.equal(resolveCNLocalRunPolicy({ currentAccountLevel: CNAccountType.BusinessMember }).maxActiveLocalRuns, null);
  assert.equal(resolveCNLocalRunPolicy({ currentAccountLevel: CNAccountType.PrivateCloud }).maxActiveLocalRuns, null);
});
