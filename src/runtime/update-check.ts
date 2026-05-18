import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import prompts from 'prompts';

export const UPDATE_CHECK_DISABLED_ENV = 'OCTOPUS_UPDATE_CHECK_DISABLED';
export const UPDATE_CHECK_REGISTRY_ENV = 'OCTOPUS_UPDATE_CHECK_REGISTRY';
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 1500;

export interface UpdateCheckCache {
  checkedAt?: string;
  latestVersion?: string;
}

export interface UpdateCheckOptions {
  args: string[];
  cliName: string;
  packageName: string;
  currentVersion: string;
  releaseNotesUrl?: string;
  now?: Date;
  cacheFile?: string;
  fetchImpl?: typeof fetch;
  promptImpl?: (message: string) => Promise<string>;
  installImpl?: (packageName: string) => Promise<number>;
  env?: NodeJS.ProcessEnv;
  stdin?: Pick<NodeJS.ReadStream, 'isTTY'>;
  stderr?: Pick<NodeJS.WriteStream, 'write' | 'isTTY'>;
}

export function updateCheckCacheFilePath(): string {
  return join(homedir(), '.octoparse', 'update-check.json');
}

export async function maybePrintUpdateNotice(options: UpdateCheckOptions): Promise<void> {
  const env = options.env ?? process.env;
  const stdin = options.stdin ?? process.stdin;
  const stderr = options.stderr ?? process.stderr;
  const now = options.now ?? new Date();
  if (!shouldRunUpdateCheck(options.args, env, Boolean(stdin.isTTY), Boolean(stderr.isTTY))) return;

  const cacheFile = options.cacheFile ?? updateCheckCacheFilePath();
  const cache = await readUpdateCheckCache(cacheFile);
  if (!isUpdateCheckDue(cache, now)) return;

  const latestVersion = await fetchLatestVersion({
    packageName: options.packageName,
    registryBaseUrl: env[UPDATE_CHECK_REGISTRY_ENV],
    fetchImpl: options.fetchImpl,
    timeoutMs: UPDATE_CHECK_TIMEOUT_MS
  }).catch(() => undefined);

  await writeUpdateCheckCache(cacheFile, {
    checkedAt: now.toISOString(),
    latestVersion: latestVersion ?? cache.latestVersion
  }).catch(() => undefined);

  if (
    latestVersion
    && compareVersions(latestVersion, options.currentVersion) > 0
  ) {
    await handleUpdateAvailable({
      cliName: options.cliName,
      packageName: options.packageName,
      currentVersion: options.currentVersion,
      latestVersion,
      releaseNotesUrl: options.releaseNotesUrl,
      cacheFile,
      cache,
      now,
      promptImpl: options.promptImpl,
      installImpl: options.installImpl,
      stderr
    });
  }
}

export function shouldRunUpdateCheck(
  args: string[],
  env: NodeJS.ProcessEnv,
  stdinIsTTY: boolean,
  stderrIsTTY: boolean
): boolean {
  if (!stdinIsTTY) return false;
  if (!stderrIsTTY) return false;
  if (args.includes('--json') || args.includes('--jsonl')) return false;
  if (args.includes('--no-update-check')) return false;
  if (env[UPDATE_CHECK_DISABLED_ENV] === '1' || env[UPDATE_CHECK_DISABLED_ENV] === 'true') return false;
  if (env.NO_UPDATE_NOTIFIER === '1' || env.NO_UPDATE_NOTIFIER === 'true') return false;
  if (env.CI === 'true' || env.CI === '1') return false;
  if (env.OCTOPUS_DETACHED_CHILD === '1') return false;
  return true;
}

export function isUpdateCheckDue(cache: UpdateCheckCache, now: Date, intervalMs = UPDATE_CHECK_INTERVAL_MS): boolean {
  if (!cache.checkedAt) return true;
  const checkedAt = Date.parse(cache.checkedAt);
  if (!Number.isFinite(checkedAt)) return true;
  return now.getTime() - checkedAt >= intervalMs;
}

export async function readUpdateCheckCache(filePath: string): Promise<UpdateCheckCache> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<UpdateCheckCache>;
    return {
      checkedAt: typeof parsed.checkedAt === 'string' ? parsed.checkedAt : undefined,
      latestVersion: typeof parsed.latestVersion === 'string' ? parsed.latestVersion : undefined
    };
  } catch {
    return {};
  }
}

export function renderUpdatePrompt(options: {
  packageName: string;
  cliName: string;
  currentVersion: string;
  latestVersion: string;
  releaseNotesUrl?: string;
}): string {
  const releaseNotesUrl = options.releaseNotesUrl ?? `https://www.npmjs.com/package/${options.packageName}`;
  return [
    options.cliName,
    '',
    `Update available! ${options.currentVersion} -> ${options.latestVersion}`,
    '',
    `Release notes: ${releaseNotesUrl}`,
    ''
  ].join('\n');
}

async function handleUpdateAvailable(options: {
  cliName: string;
  packageName: string;
  currentVersion: string;
  latestVersion: string;
  releaseNotesUrl?: string;
  cacheFile: string;
  cache: UpdateCheckCache;
  now: Date;
  promptImpl?: (message: string) => Promise<string>;
  installImpl?: (packageName: string) => Promise<number>;
  stderr: Pick<NodeJS.WriteStream, 'write' | 'isTTY'>;
}): Promise<void> {
  const answer = (await promptUser({
    packageName: options.packageName,
    cliName: options.cliName,
    currentVersion: options.currentVersion,
    latestVersion: options.latestVersion,
    releaseNotesUrl: options.releaseNotesUrl,
    promptImpl: options.promptImpl
  })).trim();

  if (answer === 'skip') return;

  if (answer === 'update') {
    const install = options.installImpl ?? installLatestVersion;
    const exitCode = await install(options.packageName).catch(() => 1);
    if (exitCode === 0) {
      options.stderr.write(`\nUpdate installed. Restart ${options.cliName} to use the new version.\n`);
    } else {
      options.stderr.write(`\nUpdate failed. Run manually: npm install -g ${options.packageName}\n`);
    }
  }
}

async function promptUser(options: {
  packageName: string;
  cliName: string;
  currentVersion: string;
  latestVersion: string;
  releaseNotesUrl?: string;
  promptImpl?: (message: string) => Promise<string>;
}): Promise<string> {
  const header = renderUpdatePrompt({
    packageName: options.packageName,
    cliName: options.cliName,
    currentVersion: options.currentVersion,
    latestVersion: options.latestVersion,
    releaseNotesUrl: options.releaseNotesUrl
  });
  if (options.promptImpl) return options.promptImpl(header);
  if (!process.stdin.isTTY || !process.stderr.isTTY) return 'skip';

  process.stderr.write(`${header}\n`);
  const response = await prompts({
    type: 'select',
    name: 'action',
    message: 'Choose update action',
    choices: [
      { title: `Update now (runs \`npm install -g ${options.packageName}\`)`, value: 'update' },
      { title: 'Skip', value: 'skip' }
    ],
    initial: 0
  });
  return response.action === 'update' ? 'update' : 'skip';
}

async function installLatestVersion(packageName: string): Promise<number> {
  return await new Promise((resolve) => {
    const child = spawn('npm', ['install', '-g', packageName], {
      stdio: 'inherit'
    });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export async function writeUpdateCheckCache(filePath: string, cache: UpdateCheckCache): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(cache, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => undefined);
}

export async function fetchLatestVersion(options: {
  packageName: string;
  registryBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const registryBaseUrl = (options.registryBaseUrl || 'https://registry.npmjs.org').replace(/\/+$/, '');
  const url = `${registryBaseUrl}/${encodeURIComponent(options.packageName).replace(/^%40/, '@')}/latest`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as { version?: unknown };
    return typeof payload.version === 'string' ? payload.version : undefined;
  } finally {
    clearTimeout(timeout);
  }
}

export function compareVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (!leftVersion || !rightVersion) return 0;

  for (let index = 0; index < 3; index += 1) {
    const diff = leftVersion.parts[index] - rightVersion.parts[index];
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }

  if (leftVersion.prerelease && !rightVersion.prerelease) return -1;
  if (!leftVersion.prerelease && rightVersion.prerelease) return 1;
  if (!leftVersion.prerelease && !rightVersion.prerelease) return 0;
  return leftVersion.prerelease.localeCompare(rightVersion.prerelease);
}

function parseVersion(version: string): { parts: [number, number, number]; prerelease: string } | null {
  const match = version.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    parts: [
      Number.parseInt(match[1] ?? '0', 10),
      Number.parseInt(match[2] ?? '0', 10),
      Number.parseInt(match[3] ?? '0', 10)
    ],
    prerelease: match[4] ?? ''
  };
}
