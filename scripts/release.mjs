#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const versionArg = args.find((arg) => !arg.startsWith('-'));
const dryRun = args.includes('--dry-run');
const noPush = args.includes('--no-push');
const npmTag = valueAfter('--tag') ?? 'latest';
const cacheDir = process.env.NPM_CONFIG_CACHE || '/tmp/octoparse-npm-cache';

if (!versionArg) {
  usage();
  process.exit(1);
}

if (!isValidVersionArg(versionArg)) {
  console.error(`Invalid version argument: ${versionArg}`);
  usage();
  process.exit(1);
}

const status = capture('git', ['status', '--porcelain']);
if (status.trim()) {
  console.error('Working tree is not clean. Commit or stash changes before releasing.');
  console.error(status);
  process.exit(1);
}

run('npm', ['run', 'test']);
run('npm', ['--cache', cacheDir, 'pack', '--dry-run']);

if (dryRun) {
  console.log('Dry run complete. No version bump, publish, or push was performed.');
  process.exit(0);
}

run('npm', ['version', versionArg]);

try {
  run('npm', ['--cache', cacheDir, 'publish', '--access', 'public', '--tag', npmTag]);
} catch (error) {
  console.error('Publish failed after npm version created a local commit and tag.');
  console.error('Fix the publish issue, then rerun: npm publish --access public');
  process.exit(error.status ?? 1);
}

if (!noPush) {
  run('git', ['push', 'origin', 'HEAD', '--tags']);
}

console.log('Release complete.');

function run(command, commandArgs) {
  console.log(`\n> ${[command, ...commandArgs].join(' ')}`);
  const result = spawnSync(command, commandArgs, { stdio: 'inherit' });
  if (result.status !== 0) {
    const error = new Error(`${command} failed`);
    error.status = result.status ?? 1;
    throw error;
  }
}

function capture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '');
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? '';
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function isValidVersionArg(value) {
  return ['patch', 'minor', 'major', 'prepatch', 'preminor', 'premajor', 'prerelease'].includes(value)
    || /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function usage() {
  console.error([
    'Usage:',
    '  npm run release -- <patch|minor|major|x.y.z> [--tag latest] [--dry-run] [--no-push]',
    '',
    'Examples:',
    '  npm run release -- patch --dry-run',
    '  npm run release -- patch',
    '  npm run release -- 0.2.0'
  ].join('\n'));
}
