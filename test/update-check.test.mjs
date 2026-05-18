import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  compareVersions,
  isUpdateCheckDue,
  maybePrintUpdateNotice,
  renderUpdatePrompt,
  shouldRunUpdateCheck
} from '../dist/runtime/update-check.js';

test('compareVersions handles normal semver and prerelease versions', () => {
  assert.equal(compareVersions('0.1.16', '0.1.15'), 1);
  assert.equal(compareVersions('0.1.15', '0.1.15'), 0);
  assert.equal(compareVersions('0.1.14', '0.1.15'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.1'), 1);
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1);
});

test('shouldRunUpdateCheck skips machine output, CI, disabled env, and non-tty stderr', () => {
  assert.equal(shouldRunUpdateCheck(['task', 'list'], {}, true, true), true);
  assert.equal(shouldRunUpdateCheck(['task', 'list', '--json'], {}, true, true), false);
  assert.equal(shouldRunUpdateCheck(['run', 'task-id', '--jsonl'], {}, true, true), false);
  assert.equal(shouldRunUpdateCheck(['task', 'list'], { CI: 'true' }, true, true), false);
  assert.equal(shouldRunUpdateCheck(['task', 'list'], { OCTOPUS_UPDATE_CHECK_DISABLED: '1' }, true, true), false);
  assert.equal(shouldRunUpdateCheck(['task', 'list'], {}, false, true), false);
  assert.equal(shouldRunUpdateCheck(['task', 'list'], {}, true, false), false);
});

test('isUpdateCheckDue uses a 24 hour interval', () => {
  const now = new Date('2026-05-18T12:00:00.000Z');
  assert.equal(isUpdateCheckDue({}, now), true);
  assert.equal(isUpdateCheckDue({ checkedAt: 'bad-date' }, now), true);
  assert.equal(isUpdateCheckDue({ checkedAt: '2026-05-18T00:00:00.000Z' }, now), false);
  assert.equal(isUpdateCheckDue({ checkedAt: '2026-05-17T11:59:59.000Z' }, now), true);
});

test('renderUpdatePrompt matches the interactive update menu', () => {
  const prompt = renderUpdatePrompt({
    cliName: 'octoparse',
    packageName: '@octoparse-cli/octoparse-cli',
    currentVersion: '0.1.16',
    latestVersion: '0.1.17',
    releaseNotesUrl: 'https://github.com/octoparse/octoparse-cli/releases/latest'
  });

  assert.match(prompt, /octoparse/);
  assert.match(prompt, /Update available! 0\.1\.16 -> 0\.1\.17/);
  assert.match(prompt, /Release notes: https:\/\/github\.com\/octoparse\/octoparse-cli\/releases\/latest/);
  assert.doesNotMatch(prompt, /Update now/);
  assert.doesNotMatch(prompt, /Skip/);
  assert.doesNotMatch(prompt, /3\./);
});

test('maybePrintUpdateNotice prompts and updates when user chooses option 1', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'octo-update-check-'));
  const cacheFile = join(dir, 'update-check.json');
  const urls = [];
  const prompts = [];
  const installs = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ version: '0.1.17' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  await maybePrintUpdateNotice({
    args: ['task', 'list'],
    cliName: 'octoparse',
    packageName: '@octoparse-cli/octoparse-cli',
    currentVersion: '0.1.16',
    now: new Date('2026-05-18T12:00:00.000Z'),
    cacheFile,
    fetchImpl,
    promptImpl: async (message) => {
      prompts.push(message);
      return 'update';
    },
    installImpl: async (packageName) => {
      installs.push(packageName);
      return 0;
    },
    env: {},
    stdin: { isTTY: true },
    stderr: {
      isTTY: true,
      write: () => true
    }
  });

  assert.deepEqual(urls, ['https://registry.npmjs.org/@octoparse-cli%2Foctoparse-cli/latest']);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Update available! 0\.1\.16 -> 0\.1\.17/);
  assert.deepEqual(installs, ['@octoparse-cli/octoparse-cli']);
  const cache = JSON.parse(await readFile(cacheFile, 'utf8'));
  assert.equal(cache.checkedAt, '2026-05-18T12:00:00.000Z');
  assert.equal(cache.latestVersion, '0.1.17');
});

test('maybePrintUpdateNotice does not fetch or print while cache is fresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'octo-update-check-fresh-'));
  const cacheFile = join(dir, 'update-check.json');
  await maybePrintUpdateNotice({
    args: ['task', 'list'],
    cliName: 'octoparse',
    packageName: '@octoparse-cli/octoparse-cli',
    currentVersion: '0.1.16',
    now: new Date('2026-05-18T12:00:00.000Z'),
    cacheFile,
    fetchImpl: async () => new Response(JSON.stringify({ version: '0.1.17' })),
    promptImpl: async () => 'skip',
    env: {},
    stdin: { isTTY: true },
    stderr: { isTTY: true, write: () => true }
  });

  const stderrChunks = [];
  let fetchCount = 0;
  await maybePrintUpdateNotice({
    args: ['task', 'list'],
    cliName: 'octoparse',
    packageName: '@octoparse-cli/octoparse-cli',
    currentVersion: '0.1.16',
    now: new Date('2026-05-18T12:30:00.000Z'),
    cacheFile,
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ version: '0.1.17' }));
    },
    env: {},
    stdin: { isTTY: true },
    stderr: {
      isTTY: true,
      write: (chunk) => {
        stderrChunks.push(String(chunk));
        return true;
      }
    }
  });

  assert.equal(fetchCount, 0);
  assert.equal(stderrChunks.join(''), '');
});
