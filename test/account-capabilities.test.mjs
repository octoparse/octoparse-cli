import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OPAccountType,
  resolveOPLocalRunPolicy
} from '../dist/runtime/account-capabilities.js';

const limits = {
  localRunLimit: {
    freeCount: 1,
    professionCount: 2,
    ultimateCount: 3,
    basicCount: 4,
    ultimatePlusCount: 5,
    maxCount: -1,
    businessMember: 6
  }
};

test('OP local run policy uses service-provided package limits', () => {
  assert.equal(resolveOPLocalRunPolicy({ type: OPAccountType.Free }, limits).maxActiveLocalRuns, 1);
  assert.equal(resolveOPLocalRunPolicy({ type: OPAccountType.Standard }, limits).maxActiveLocalRuns, 2);
  assert.equal(resolveOPLocalRunPolicy({ type: OPAccountType.Professional }, limits).maxActiveLocalRuns, 3);
  assert.equal(resolveOPLocalRunPolicy({ type: OPAccountType.Basic }, limits).maxActiveLocalRuns, 4);
  assert.equal(resolveOPLocalRunPolicy({ type: OPAccountType.UltimatePlus }, limits).maxActiveLocalRuns, 5);
  assert.equal(resolveOPLocalRunPolicy({ type: OPAccountType.BusinessMember }, limits).maxActiveLocalRuns, 6);
});

test('OP private cloud maxCount below zero means unlimited local runs', () => {
  assert.deepEqual(
    resolveOPLocalRunPolicy({ type: OPAccountType.PrivateCloud }, limits),
    {
      accountLevel: OPAccountType.PrivateCloud,
      maxActiveLocalRuns: null
    }
  );
});

test('OP policy treats expired or explicitly free accounts as free level', () => {
  assert.deepEqual(
    resolveOPLocalRunPolicy({
      type: OPAccountType.Professional,
      effectiveDate: '2020-01-01T00:00:00Z'
    }, limits),
    {
      accountLevel: OPAccountType.Free,
      maxActiveLocalRuns: 1
    }
  );

  assert.deepEqual(
    resolveOPLocalRunPolicy({
      type: OPAccountType.Basic,
      isFreeAccount: true
    }, limits),
    {
      accountLevel: OPAccountType.Free,
      maxActiveLocalRuns: 1
    }
  );
});

test('OP enterprise professional accounts keep the package type limit used by desktop client', () => {
  assert.deepEqual(
    resolveOPLocalRunPolicy({
      type: OPAccountType.Professional,
      isEnterprise: true
    }, limits),
    {
      accountLevel: OPAccountType.Professional,
      maxActiveLocalRuns: 3
    }
  );
});
