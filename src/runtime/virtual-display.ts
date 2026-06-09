import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface VirtualDisplayHandle {
  display?: string;
  enabled: boolean;
  close(): Promise<void>;
}

export function hasLinuxDisplayEnvironment(): boolean {
  return process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

export function requiresVirtualDisplay(): boolean {
  return process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

export function virtualDisplayInstallMessage(): string {
  return 'Linux has no DISPLAY/WAYLAND_DISPLAY, but the browser runtime needs visible Chrome. Install system browser dependencies, for example on Ubuntu/Debian: apt-get update && apt-get install -y libnss3 libnspr4 xvfb, then retry. Manual recognition can also run in a desktop/VNC session.';
}

export async function startVirtualDisplayIfNeeded(): Promise<VirtualDisplayHandle> {
  if (!requiresVirtualDisplay()) {
    return {
      enabled: false,
      async close() {}
    };
  }
  if (!commandExists('Xvfb')) throw new Error(virtualDisplayInstallMessage());
  const display = await allocateDisplay();
  const tempDir = await mkdtemp(join(tmpdir(), 'octoparse-xvfb-'));
  const previousDisplay = process.env.DISPLAY;
  const child = spawn('Xvfb', [
    display,
    '-screen',
    '0',
    '1920x1200x24',
    '-nolisten',
    'tcp',
    '-ac'
  ], {
    env: {
      ...process.env,
      TMPDIR: tempDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForDisplaySocket(display, child);
  process.env.DISPLAY = display;
  return {
    display,
    enabled: true,
    async close() {
      if (process.env.DISPLAY === display) delete process.env.DISPLAY;
      if (previousDisplay !== undefined) process.env.DISPLAY = previousDisplay;
      child.kill('SIGTERM');
      await waitForExit(child, 1500);
      if (child.exitCode === null) child.kill('SIGKILL');
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

function commandExists(command: string): boolean {
  const paths = (process.env.PATH || '').split(':').filter(Boolean);
  return paths.some((dir) => existsSync(join(dir, command)));
}

async function allocateDisplay(): Promise<string> {
  for (let display = 90; display < 140; display += 1) {
    const socketPath = `/tmp/.X11-unix/X${display}`;
    if (!existsSync(socketPath)) return `:${display}`;
  }
  throw new Error('No available Xvfb display port.');
}

async function waitForDisplaySocket(display: string, child: ChildProcess): Promise<void> {
  const displayNumber = display.replace(/^:/, '');
  const socketPath = `/tmp/.X11-unix/X${displayNumber}`;
  const stderr: string[] = [];
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    stderr.push(String(chunk));
  });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) return;
    if (child.exitCode !== null) {
      throw new Error(`Xvfb failed to start: ${stderr.join('').trim() || `exit code ${child.exitCode}`}`);
    }
    await delay(50);
  }
  child.kill('SIGKILL');
  throw new Error(`Timed out waiting for Xvfb to start: ${stderr.join('').trim()}`);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    delay(timeoutMs)
  ]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
