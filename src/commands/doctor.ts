import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { hasFlag, valueAfter } from '../cli/args.js';
import { printResult } from '../cli/output.js';
import { EXIT_OK, EXIT_RUNTIME_FAILED } from '../types.js';

const require = createRequire(import.meta.url);
const EngineModule = require('@octopus/engine');
const resolveChrome = EngineModule.resolveChrome as () => Promise<{ executablePath: string }>;

export async function doctorCommand(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const chromePath = valueAfter(args, '--chrome-path');
  let chrome: { ok: boolean; message: string } = { ok: false, message: 'not checked' };
  if (chromePath) {
    chrome = existsSync(chromePath)
      ? { ok: true, message: chromePath }
      : { ok: false, message: `Chrome executable not found: ${chromePath}` };
  } else {
    try {
      const resolved = await resolveChrome();
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
    if (!executablePath) {
      executablePath = (await resolveChrome()).executablePath;
    }
    ok = Boolean(executablePath) && existsSync(executablePath);
    if (!ok) error = `Chrome executable not found: ${executablePath}`;
  } catch (caught) {
    ok = false;
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const data = {
    ok,
    supported: ['chrome'],
    unsupported: ['kernel', 'legacy-workflow'],
    executablePath,
    message: ok ? 'independent Chrome is ready' : error
  };
  printResult(json, data);
  return ok ? EXIT_OK : EXIT_RUNTIME_FAILED;
}
