import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hasFlag, valueAfter } from '../cli/args.js';
import { printEnvelope, printResult } from '../cli/output.js';
import { createChromeProgressReporter, type ChromeResolveStatus } from '../runtime/chrome-progress.js';
import { LINUX_ARM64_UNSUPPORTED_CODE, LINUX_ARM64_UNSUPPORTED_MESSAGE, isLinuxArm64Runtime } from '../runtime/platform-support.js';
import { hasLinuxDisplayEnvironment, startVirtualDisplayIfNeeded } from '../runtime/virtual-display.js';
import { EXIT_OK, EXIT_RUNTIME_FAILED } from '../types.js';

const require = createRequire(import.meta.url);
const EngineModule = require('@octopus/engine');
const resolveChrome = EngineModule.resolveChrome as (options?: { onStatus?: (status: ChromeResolveStatus) => void }) => Promise<{ executablePath: string }>;

export async function doctorCommand(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const chromePath = valueAfter(args, '--chrome-path');
  let chrome: { ok: boolean; message: string } = { ok: false, message: 'not checked' };
  if (isLinuxArm64Runtime()) {
    chrome = { ok: false, message: LINUX_ARM64_UNSUPPORTED_MESSAGE };
  } else if (chromePath) {
    chrome = existsSync(chromePath)
      ? { ok: true, message: chromePath }
      : { ok: false, message: `Chrome executable not found: ${chromePath}` };
  } else {
    try {
      const chromeProgress = createChromeProgressReporter({
        enabled: !json,
        write: (message) => process.stderr.write(message)
      });
      const resolved = await resolveChrome({ onStatus: chromeProgress?.onStatus });
      chrome = { ok: true, message: resolved.executablePath };
    } catch (error) {
      chrome = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  const engineDist = dirname(require.resolve('@octopus/engine'));
  const extensionPath = join(engineDist, 'extension', 'manifest.json');
  const ublockPath = join(engineDist, 'extensions', 'ublock-origin-lite', 'uBOLite.chromium.tar.xz');
  const data = {
    ok: chrome.ok && existsSync(extensionPath),
    checks: [
      { name: 'node', ok: true, message: process.version },
      { name: 'engine', ok: true, message: require.resolve('@octopus/engine') },
      { name: 'runtime-extension', ok: existsSync(extensionPath), message: extensionPath },
      { name: 'adblock-extension-archive', ok: existsSync(ublockPath), message: ublockPath },
      { name: 'chrome', ok: chrome.ok, message: chrome.message },
      { name: 'electron-client', ok: true, message: 'not required' },
      { name: 'browser-mode', ok: true, message: 'independent Chrome only' }
    ]
  };
  printResult(json, data);
  return EXIT_OK;
}

export async function browserDoctorCommand(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const chromePath = valueAfter(args, '--chrome-path');
  let executablePath = chromePath;
  let ok = true;
  let error = '';

  try {
    if (isLinuxArm64Runtime()) {
      if (json) printEnvelope(false, undefined, LINUX_ARM64_UNSUPPORTED_CODE, LINUX_ARM64_UNSUPPORTED_MESSAGE);
      else console.error(LINUX_ARM64_UNSUPPORTED_MESSAGE);
      return EXIT_RUNTIME_FAILED;
    }
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
  const data = {
    ok,
    supported: ['chrome'],
    unsupported: ['kernel', 'legacy-workflow'],
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
  if (!ok) {
    if (json) printEnvelope(false, undefined, 'CHROME_LAUNCH_FAILED', data.message);
    else console.error(data.message);
    return EXIT_RUNTIME_FAILED;
  }
  printResult(json, data);
  return EXIT_OK;
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
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        finish({ ok: false, error: error.message, stderr });
      });
      child.on('close', (code, signal) => {
        finish({ ok: code === 0, code, signal, stderr });
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
