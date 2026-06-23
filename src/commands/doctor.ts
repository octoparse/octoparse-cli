import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hasFlag, valueAfter } from '../cli/args.js';
import { printEnvelope } from '../cli/output.js';
import { resolveApiBaseUrl } from '../runtime/api-client.js';
import { clientHeaders } from '../runtime/client-headers.js';
import { resolveAuth, type AuthCredential } from '../runtime/auth.js';
import { createChromeProgressReporter, type ChromeResolveStatus } from '../runtime/chrome-progress.js';
import { defaultRunsDir } from '../runtime/local-runs.js';
import { LINUX_ARM64_UNSUPPORTED_CODE, LINUX_ARM64_UNSUPPORTED_MESSAGE, isLinuxArm64Runtime } from '../runtime/platform-support.js';
import { hasLinuxDisplayEnvironment, startVirtualDisplayIfNeeded } from '../runtime/virtual-display.js';
import { EXIT_OK, EXIT_RUNTIME_FAILED } from '../types.js';

const require = createRequire(import.meta.url);
const EngineModule = require('@octopus/engine');
const resolveChrome = EngineModule.resolveChrome as (options?: { onStatus?: (status: ChromeResolveStatus) => void }) => Promise<{ executablePath: string }>;
const DOCTOR_API_TIMEOUT_MS = 5000;

type DoctorSeverity = 'ok' | 'warning' | 'error';

interface DoctorCheck {
  name: string;
  ok: boolean;
  severity: DoctorSeverity;
  message: string;
  details?: Record<string, unknown>;
}

interface BrowserReadiness {
  ok: boolean;
  executablePath?: string;
  launchMode?: 'visible' | 'virtual-display';
  manualBrowser: {
    ok: boolean;
    message: string;
  };
  message: string;
}

export async function doctorCommand(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const chromePath = valueAfter(args, '--chrome-path');
  const checks: DoctorCheck[] = [];
  const engineDist = dirname(require.resolve('@octopus/engine'));
  const extensionPath = join(engineDist, 'extension', 'manifest.json');
  const ublockPath = join(engineDist, 'extensions', 'ublock-origin-lite', 'uBOLite.chromium.tar.xz');

  checks.push(
    okCheck('node', process.version, { required: '>=20' }),
    okCheck('engine', require.resolve('@octopus/engine')),
    checkFile('runtime-extension', extensionPath),
    checkFile('adblock-extension-archive', ublockPath),
    protectModuleCheck()
  );

  let browser: BrowserReadiness | undefined;
  if (isLinuxArm64Runtime()) {
    checks.push(errorCheck('chrome', LINUX_ARM64_UNSUPPORTED_MESSAGE, { code: LINUX_ARM64_UNSUPPORTED_CODE }));
  } else {
    browser = await checkBrowserReadiness(chromePath, json);
    checks.push({
      name: 'chrome',
      ok: browser.ok,
      severity: browser.ok ? 'ok' : 'error',
      message: browser.message,
      details: {
        executablePath: browser.executablePath,
        launchMode: browser.launchMode
      }
    });
    checks.push({
      name: 'manual-browser-display',
      ok: browser.manualBrowser.ok,
      severity: browser.manualBrowser.ok ? 'ok' : 'warning',
      message: browser.manualBrowser.message
    });
  }

  checks.push(await authCheck(valueAfter(args, '--api-base-url')));
  checks.push(await runDirectoryCheck(valueAfter(args, '--output') ?? defaultRunsDir()));

  const data = {
    ok: checks.every((check) => check.severity !== 'error'),
    checks,
    summary: doctorSummary(checks),
    browser,
    runtime: {
      supported: ['chrome'],
      unsupported: ['kernel', 'legacy-workflow'],
      browserMode: 'independent Chrome only',
      electronClient: 'not required'
    }
  };

  if (!data.ok) {
    const blocking = checks.find((check) => check.severity === 'error');
    const linuxArm64 = checks.find((check) => check.details?.code === LINUX_ARM64_UNSUPPORTED_CODE);
    const code = linuxArm64
      ? LINUX_ARM64_UNSUPPORTED_CODE
      : blocking?.name === 'chrome'
      ? 'CHROME_LAUNCH_FAILED'
      : 'DOCTOR_FAILED';
    if (json) printDoctorFailureJson(data, code, linuxArm64?.message ?? blocking?.message ?? 'doctor checks failed');
    else printDoctorHuman(data);
    return EXIT_RUNTIME_FAILED;
  }

  if (json) printEnvelope(true, data);
  else printDoctorHuman(data);
  return EXIT_OK;
}

async function checkBrowserReadiness(chromePath: string | undefined, json: boolean): Promise<BrowserReadiness> {
  let executablePath = chromePath;
  let ok = true;
  let error = '';

  try {
    if (!executablePath) {
      const chromeProgress = createChromeProgressReporter({
        enabled: !json,
        write: (message) => process.stderr.write(message)
      });
      executablePath = (await resolveChrome({ onStatus: chromeProgress?.onStatus })).executablePath;
    }
    const launch = executablePath
      ? await checkChromeExecutable(executablePath, { useVirtualDisplay: true })
      : { ok: false, message: 'Chrome executable not found' };
    ok = launch.ok;
    error = launch.ok ? '' : launch.message;
  } catch (caught) {
    ok = false;
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const manualDisplayAvailable = hasLinuxDisplayEnvironment();
  return {
    ok,
    executablePath,
    launchMode: ok ? manualDisplayAvailable ? 'visible' : 'virtual-display' : undefined,
    manualBrowser: {
      ok: manualDisplayAvailable,
      message: manualDisplayAvailable
        ? 'visible browser workflows can use the current display'
        : 'No DISPLAY or WAYLAND_DISPLAY is set; non-manual workflows can use automatic Xvfb, but manual workflows need a visible desktop session or VNC.'
    },
    message: ok
      ? manualDisplayAvailable
        ? 'independent Chrome is ready'
        : 'independent Chrome is ready with automatic Xvfb for non-manual workflows; manual workflows need a visible display'
      : error
  };
}

async function checkChromeExecutable(executablePath: string, options: { useVirtualDisplay: boolean }): Promise<{ ok: boolean; message: string }> {
  if (!existsSync(executablePath)) return { ok: false, message: `Chrome executable not found: ${executablePath}` };
  const virtualDisplay = options.useVirtualDisplay ? await startVirtualDisplayIfNeeded() : undefined;
  try {
    const result = await launchChromeVisible(executablePath);
    if (result.ok) return { ok: true, message: virtualDisplay?.enabled ? 'Chrome launch succeeded with Xvfb' : 'Chrome launch succeeded' };
    return { ok: false, message: chromeLaunchFailureMessage(result) };
  } finally {
    await virtualDisplay?.close();
  }
}

async function launchChromeVisible(executablePath: string): Promise<{
  ok: boolean;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  stderr?: string;
  error?: string;
}> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'octoparse-browser-doctor-'));
  try {
    return await new Promise((resolve) => {
      const child = spawn(executablePath, [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--no-first-run',
        '--window-size=800,600',
        `--user-data-dir=${userDataDir}`,
        'about:blank'
      ], {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'ignore', 'pipe']
      });
      let stderr = '';
      let settled = false;
      const finish = (result: { ok: boolean; code?: number | null; signal?: NodeJS.Signals | null; stderr?: string; error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        void finishChromeLaunchProbe(child, result).then(resolve);
      };
      const startupTimer = setTimeout(() => {
        finish({ ok: true, stderr });
      }, 2500);
      const childStderr = child.stderr;
      childStderr?.setEncoding('utf8');
      childStderr?.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        finish({ ok: false, error: error.message, stderr });
      });
      child.on('close', (code, signal) => {
        finish({ ok: false, code, signal, stderr: stderr || 'Chrome exited before the startup check completed' });
      });
    });
  } finally {
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function finishChromeLaunchProbe(
  child: ChildProcess,
  result: { ok: boolean; code?: number | null; signal?: NodeJS.Signals | null; stderr?: string; error?: string }
): Promise<{ ok: boolean; code?: number | null; signal?: NodeJS.Signals | null; stderr?: string; error?: string }> {
  if (result.ok && isChildRunning(child)) {
    terminateChromeProbe(child, 'SIGTERM');
    await waitForChildClose(child, 1500);
    if (isChildRunning(child)) {
      terminateChromeProbe(child, 'SIGKILL');
      await waitForChildClose(child, 1500);
    }
  }
  if (isChildRunning(child)) {
    child.stderr?.destroy();
    child.unref();
  }
  return result;
}

function isChildRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function terminateChromeProbe(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to killing the direct child process.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Best-effort cleanup only; the probe result should still be reported.
  }
}

async function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (!isChildRunning(child)) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once('close', () => resolve())),
    delay(timeoutMs)
  ]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chromeLaunchFailureMessage(result: {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  stderr?: string;
  error?: string;
}): string {
  const detail = (result.stderr || result.error || '').trim();
  const status = result.signal ? `signal ${result.signal}` : `exit code ${result.code ?? 'unknown'}`;
  const hint = chromeLaunchInstallHint(detail);
  if (!detail) return `Chrome failed to launch (${status}).${hint ? ` ${hint}` : ''}`;
  return `Chrome failed to launch (${status}): ${detail}${hint ? ` ${hint}` : ''}`;
}

function chromeLaunchInstallHint(detail: string): string {
  if (/lib(nss3|nspr4|nssutil3|smime3)\.so|error while loading shared libraries/i.test(detail)) {
    return 'Install Chrome runtime libraries, for example on Ubuntu/Debian: apt-get update && apt-get install -y libnss3 libnspr4.';
  }
  if (/Missing X server|no DISPLAY|ozone_platform_x11|Gtk-WARNING|cannot open display/i.test(detail)) {
    return 'Install Xvfb for headless servers, for example on Ubuntu/Debian: apt-get update && apt-get install -y xvfb.';
  }
  return '';
}

function okCheck(name: string, message: string, details?: Record<string, unknown>): DoctorCheck {
  return { name, ok: true, severity: 'ok', message, ...(details ? { details } : {}) };
}

function warningCheck(name: string, message: string, details?: Record<string, unknown>): DoctorCheck {
  return { name, ok: false, severity: 'warning', message, ...(details ? { details } : {}) };
}

function errorCheck(name: string, message: string, details?: Record<string, unknown>): DoctorCheck {
  return { name, ok: false, severity: 'error', message, ...(details ? { details } : {}) };
}

function checkFile(name: string, filePath: string): DoctorCheck {
  return existsSync(filePath)
    ? okCheck(name, filePath)
    : errorCheck(name, `missing: ${filePath}`);
}

function protectModuleCheck(): DoctorCheck {
  try {
    const loaded = require('@octopus/octopus-protect') as { default?: unknown };
    const protect = (loaded.default ?? loaded) as {
      vk?: unknown;
      vn?: { vf?: unknown; revf?: unknown };
      en?: { ensk?: unknown; desk?: unknown };
    };
    const ok = typeof protect?.vk === 'function'
      && typeof protect.vn?.vf === 'function'
      && typeof protect.vn?.revf === 'function'
      && typeof protect.en?.ensk === 'function'
      && typeof protect.en?.desk === 'function';
    return ok
      ? okCheck('protect-native-module', require.resolve('@octopus/octopus-protect'))
      : errorCheck('protect-native-module', 'bundled @octopus/octopus-protect module is missing required native functions');
  } catch (error) {
    return errorCheck('protect-native-module', error instanceof Error ? error.message : String(error));
  }
}

async function authCheck(baseUrlArg: string | undefined): Promise<DoctorCheck> {
  let baseUrl = '';
  try {
    baseUrl = await resolveApiBaseUrl(baseUrlArg);
  } catch (error) {
    return warningCheck('api-base-url', error instanceof Error ? error.message : String(error));
  }

  const auth = await resolveAuth().catch((error) => ({
    authenticated: false,
    source: 'none' as const,
    method: 'none' as const,
    credentialsFile: '',
    error: error instanceof Error ? error.message : String(error)
  }));
  if ('error' in auth) {
    return warningCheck('auth', auth.error, { baseUrl });
  }
  if (!auth.authenticated || !auth.credential) {
    return warningCheck('auth', 'not logged in; run "octoparse auth login" before functional commands', {
      baseUrl,
      credentialsFile: auth.credentialsFile
    });
  }

  try {
    const account = await fetchAccountInfoForDoctor(auth.credential, baseUrl);
    return okCheck('api', `authenticated via ${auth.source}/${auth.method}`, {
      baseUrl,
      endpoint: account.endpoint,
      userId: account.userId
    });
  } catch (error) {
    return warningCheck('api', error instanceof Error ? error.message : String(error), {
      baseUrl,
      authSource: auth.source,
      authMethod: auth.method
    });
  }
}

async function fetchAccountInfoForDoctor(credential: AuthCredential, baseUrl: string): Promise<{ endpoint: string; userId?: unknown }> {
  const endpoint = '/api/account/getAccount';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOCTOR_API_TIMEOUT_MS);
  try {
    const response = await fetch(new URL(endpoint, `${baseUrl}/`), {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en-US',
        ...clientHeaders(),
        ...doctorAuthHeaders(credential)
      }
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`API request failed: HTTP ${response.status} ${response.statusText} (${baseUrl}${endpoint})${body ? `: ${trimDoctorBody(body)}` : ''}`);
    }
    const payload = JSON.parse(body || 'null') as unknown;
    const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
    if (record?.isSuccess === false) {
      throw new Error(String(record.error_Description || record.error || 'API returned isSuccess=false'));
    }
    const data = record?.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? record.data as Record<string, unknown>
      : undefined;
    if (!data) throw new Error('Account response is missing data');
    return { endpoint, userId: data.userId };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`API reachability check timed out after ${DOCTOR_API_TIMEOUT_MS}ms (${baseUrl}${endpoint})`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function doctorAuthHeaders(credential: AuthCredential): Record<string, string> {
  return credential.type === 'bearer'
    ? { Authorization: `Bearer ${credential.value}` }
    : { 'x-api-key': credential.value };
}

function trimDoctorBody(body: string): string {
  return body.length > 500 ? `${body.slice(0, 500)}...` : body;
}

async function runDirectoryCheck(outputDir: string): Promise<DoctorCheck> {
  try {
    await mkdir(outputDir, { recursive: true });
    const tempFile = join(outputDir, `.doctor-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
    await writeFile(tempFile, 'ok\n', 'utf8');
    await rm(tempFile, { force: true });
    return okCheck('local-runs-directory', outputDir);
  } catch (error) {
    return errorCheck('local-runs-directory', error instanceof Error ? error.message : String(error), { outputDir });
  }
}

function doctorSummary(checks: DoctorCheck[]): { errors: number; warnings: number; ok: number } {
  return {
    errors: checks.filter((check) => check.severity === 'error').length,
    warnings: checks.filter((check) => check.severity === 'warning').length,
    ok: checks.filter((check) => check.severity === 'ok').length
  };
}

function printDoctorHuman(data: {
  ok: boolean;
  checks: DoctorCheck[];
  summary: { errors: number; warnings: number; ok: number };
}): void {
  const write = data.ok ? console.log : console.error;
  write(`Doctor ${data.ok ? 'passed' : 'failed'}: ${data.summary.ok} ok, ${data.summary.warnings} warnings, ${data.summary.errors} errors`);
  for (const check of data.checks) {
    const prefix = check.severity === 'ok' ? 'OK' : check.severity === 'warning' ? 'WARN' : 'FAIL';
    write(`[${prefix}] ${check.name}: ${check.message}`);
  }
}

function printDoctorFailureJson(data: unknown, code: string, message: string): void {
  console.log(JSON.stringify({
    ok: false,
    error: { code, message },
    data
  }));
}
