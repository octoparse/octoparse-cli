import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLocalRunResourceWarning } from '../dist/commands/run.js';

test('local run resource warning starts at projected run threshold', () => {
  assert.equal(buildLocalRunResourceWarning(2, 1), undefined);

  const warning = buildLocalRunResourceWarning(3, 1);
  assert.equal(warning?.code, 'LOCAL_RUN_RESOURCE_WARNING');
  assert.equal(warning?.severity, 'warning');
  assert.equal(warning?.activeLocalRuns, 3);
  assert.equal(warning?.requestedLocalRuns, 1);
  assert.equal(warning?.projectedLocalRuns, 4);
  assert.match(warning?.message ?? '', /Chrome process/);
});

test('local run resource warning becomes strong at higher projected count', () => {
  const warning = buildLocalRunResourceWarning(5, 1);
  assert.equal(warning?.severity, 'strong_warning');
  assert.equal(warning?.projectedLocalRuns, 6);
});
