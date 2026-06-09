import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChromeProgressReporter, formatChromeProgressBar, formatChromeResolveStatus } from '../dist/runtime/chrome-progress.js';

test('formatChromeResolveStatus formats download states and clamps progress', () => {
  assert.equal(formatChromeResolveStatus({ state: 'checking', progress: 0 }), 'Chrome checking 0%');
  assert.equal(formatChromeResolveStatus({ state: 'downloading', progress: 42.4 }), 'Chrome downloading 42%');
  assert.equal(formatChromeResolveStatus({ state: 'retrying', progress: 0 }), 'Chrome download retrying 0%');
  assert.equal(formatChromeResolveStatus({ state: 'completed', progress: 100 }), 'Chrome ready 100%');
  assert.equal(formatChromeResolveStatus({ state: 'failed' }), 'Chrome setup failed');
  assert.equal(formatChromeResolveStatus({ state: 'downloading', progress: 120 }), 'Chrome downloading 100%');
});

test('formatChromeProgressBar formats a bounded progress bar', () => {
  assert.equal(formatChromeProgressBar({ state: 'checking', progress: 0 }, 10), 'Chrome checking [----------] 0%');
  assert.equal(formatChromeProgressBar({ state: 'downloading', progress: 42.4 }, 10), 'Chrome downloading [====------] 42%');
  assert.equal(formatChromeProgressBar({ state: 'completed', progress: 100 }, 10), 'Chrome ready [==========] 100%');
  assert.equal(formatChromeProgressBar({ state: 'failed' }, 10), 'Chrome setup failed');
});

test('createChromeProgressReporter writes deduped lines for non-interactive output', () => {
  const lines = [];
  const reporter = createChromeProgressReporter({
    enabled: true,
    interactive: false,
    write: (message) => lines.push(message)
  });

  reporter.onStatus({ state: 'downloading', progress: 10 });
  reporter.onStatus({ state: 'downloading', progress: 10 });
  reporter.onStatus({ state: 'completed', progress: 100 });

  assert.deepEqual(lines, [
    'Chrome downloading 10%\n',
    'Chrome ready 100%\n'
  ]);
  assert.equal(createChromeProgressReporter({ enabled: false }), undefined);
});

test('createChromeProgressReporter overwrites one line for interactive output', () => {
  const writes = [];
  const reporter = createChromeProgressReporter({
    enabled: true,
    interactive: true,
    barWidth: 10,
    write: (message) => writes.push(message)
  });

  reporter.onStatus({ state: 'downloading', progress: 10 });
  reporter.onStatus({ state: 'downloading', progress: 10 });
  reporter.onStatus({ state: 'downloading', progress: 20 });
  reporter.onStatus({ state: 'completed', progress: 100 });

  assert.deepEqual(writes, [
    '\rChrome downloading [=---------] 10%',
    '\rChrome downloading [==--------] 20%',
    '\rChrome ready [==========] 100%     \n'
  ]);
});
