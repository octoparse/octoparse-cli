import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { hasFlag, valueAfter } from '../../cli/args.js';
import { safeFileName, safeTaskName } from '../../runtime/naming.js';

export function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 && String(parsed) === value.trim() ? parsed : undefined;
}

export function validateRunSample(args: string[]): string | null {
  if (!hasFlag(args, '--run-sample')) return null;
  const raw = valueAfter(args, '--run-sample');
  if (!raw || raw.startsWith('-')) return '--run-sample requires a positive integer';
  return parseOptionalPositiveInt(raw) ? null : '--run-sample requires a positive integer';
}

export function parseDetectInput(args: string[]): Record<string, string> | undefined {
  const input: Record<string, string> = {};
  const query = valueAfter(args, '--query');
  if (query) input.q = query;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--input') continue;
    const raw = args[index + 1];
    if (!raw || raw.startsWith('-')) continue;
    const eq = raw.indexOf('=');
    if (eq === -1) input.q = raw;
    else input[raw.slice(0, eq)] = raw.slice(eq + 1);
  }
  return Object.keys(input).length ? input : undefined;
}

export function resolveAgentScreenshotPath(args: string[], url: string): string | undefined {
  if (!hasFlag(args, '--prepare-agent') && !hasFlag(args, '--agent')) return undefined;
  const output = valueAfter(args, '--output');
  if (output) {
    const resolvedOutput = resolve(output);
    const ext = extname(resolvedOutput);
    const base = ext ? resolvedOutput.slice(0, -ext.length) : resolvedOutput;
    return `${base}.fullpage.png`;
  }
  let host = 'page';
  try {
    host = safeFileName(new URL(url).hostname || 'page');
  } catch {
    host = safeFileName(url || 'page');
  }
  return resolve(`detected_${host}.fullpage.png`);
}

export function resolveAvailableDetectedTaskFile(taskId: string): string {
  const base = resolve(`${safeFileName(taskId)}.json`);
  if (!existsSync(base)) return base;
  const dir = dirname(base);
  const ext = extname(base);
  const name = basename(base, ext);
  for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const candidate = join(dir, `${name}-${index}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return base;
}

export function defaultDetectedTaskName(url: string): string {
  try {
    const parsed = new URL(url);
    const path = `${parsed.hostname}${parsed.pathname}${parsed.search}`.replace(/\/+$/, '');
    return safeTaskName(path || parsed.hostname);
  } catch {
    return safeTaskName(url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''));
  }
}

export function splitRunUrlArgs(args: string[]): { detectArgs: string[]; runArgs: string[] } {
  const detectValueFlags = new Set([
    '--goal',
    '--input',
    '--query',
    '--submit',
    '--select',
    '--wait-ms',
    '--scrolls',
    '--max-candidates',
    '--task-id',
    '--task-name',
    '--session-name',
    '--agent-command',
    '--api-base-url'
  ]);
  const detectBooleanFlags = new Set([
    '--auto',
    '--agent',
    '--yes',
    '--confirm-agent-plan',
    '--keep-agent-files',
    '--allow-agent-risk',
    '--manual',
    '--interactive',
    '--llm-rank',
    '--no-dismiss-popups',
    '--save-session'
  ]);
  const runValueFlags = new Set(['--output', '--max-rows', '--extension-timeout-ms']);
  const runBooleanFlags = new Set(['--headless', '--disable-image', '--disable-ad', '--debug-bridge', '--detach', '--json', '--jsonl']);
  const sharedValueFlags = new Set(['--chrome-path', '--timeout-ms']);
  const detectArgs: string[] = [];
  const runArgs: string[] = [];

  const pushValue = (target: string[], flag: string, value: string | undefined) => {
    target.push(flag);
    if (value !== undefined) target.push(value);
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (sharedValueFlags.has(arg)) {
      pushValue(detectArgs, arg, value);
      pushValue(runArgs, arg, value);
      index += 1;
      continue;
    }
    if (detectValueFlags.has(arg)) {
      pushValue(detectArgs, arg, value);
      index += 1;
      continue;
    }
    if (runValueFlags.has(arg)) {
      pushValue(runArgs, arg, value);
      index += 1;
      continue;
    }
    if (detectBooleanFlags.has(arg)) {
      detectArgs.push(arg);
      continue;
    }
    if (runBooleanFlags.has(arg)) {
      runArgs.push(arg);
      continue;
    }
    runArgs.push(arg);
  }
  return { detectArgs, runArgs };
}
