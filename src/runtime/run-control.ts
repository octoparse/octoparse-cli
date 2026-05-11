import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RunStatus, RunSummary } from '../types.js';

export type RunControlCommand = 'status' | 'pause' | 'resume' | 'stop';
export type ActiveRunStatus = RunStatus | 'paused' | 'stopping';

export interface RunControlState {
  runId: string;
  lotId: string;
  taskId: string;
  taskName?: string;
  pid: number;
  socketPath: string;
  status: ActiveRunStatus;
  outputDir: string;
  updatedAt: string;
}

export interface RunControlResponse {
  ok: boolean;
  data?: RunControlState;
  error?: string;
}

export interface RunControlServer {
  socketPath: string;
  updateStatus(status: ActiveRunStatus): Promise<void>;
  close(): Promise<void>;
}

export interface RunControlCleanupItem {
  filePath: string;
  taskId?: string;
  runId?: string;
  socketPath?: string;
  lastStatus?: ActiveRunStatus;
}

export interface RunControlCleanupResult {
  checked: number;
  alive: number;
  removed: number;
  orphaned: RunControlCleanupItem[];
}

export async function startRunControlServer(options: {
  runDir: string;
  outputDir: string;
  runId: string;
  lotId: string;
  taskId: string;
  taskName: string;
  onCommand: (command: RunControlCommand, state: RunControlState) => Promise<ActiveRunStatus>;
}): Promise<RunControlServer> {
  const socketPath = join(tmpdir(), `octo-${process.pid}-${shortHash(options.runId)}.sock`);
  await unlink(socketPath).catch(() => undefined);

  let state: RunControlState = {
    runId: options.runId,
    lotId: options.lotId,
    taskId: options.taskId,
    taskName: options.taskName,
    pid: process.pid,
    socketPath,
    status: 'running',
    outputDir: options.outputDir,
    updatedAt: new Date().toISOString()
  };

  const writeState = async () => {
    await mkdir(dirname(controlFilePath(options.runDir)), { recursive: true });
    await writeFile(controlFilePath(options.runDir), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await mkdir(dirname(taskControlFilePath(options.taskId)), { recursive: true });
    await writeFile(taskControlFilePath(options.taskId), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  };

  const server = createServer((socket) => {
    void handleSocket(socket, async (command) => {
      const status = await options.onCommand(command, state);
      state = { ...state, status, updatedAt: new Date().toISOString() };
      await writeState().catch(() => undefined);
      return { ok: true, data: state };
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });

  await writeState();

  return {
    socketPath,
    async updateStatus(status: ActiveRunStatus) {
      state = { ...state, status, updatedAt: new Date().toISOString() };
      await writeState();
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(socketPath).catch(() => undefined);
      await unlinkTaskControlFile(options.taskId, socketPath);
    }
  };
}

export async function sendTaskControlCommand(taskId: string, command: RunControlCommand): Promise<RunControlState> {
  const state = await readTaskControlState(taskId);
  if (!state) {
    throw new Error(`Task ${taskId} has no active local extraction`);
  }
  const socketPath = resolveSocketPath(state.socketPath);
  if (!socketPath) {
    await cleanupStaleTaskState(state);
    throw new Error(`The local control channel for task ${taskId} is unavailable; stale run state was cleaned up. Restart the task.`);
  }

  let response: RunControlResponse;
  try {
    response = await requestControl(socketPath, command);
  } catch {
    await cleanupStaleTaskState(state);
    throw new Error(`The local control channel for task ${taskId} is unavailable; stale run state was cleaned up. Restart the task.`);
  }
  if (!response.ok || !response.data) {
    throw new Error(response.error || `Failed to control task ${taskId}`);
  }
  return response.data;
}

export async function sendRunControlCommand(outputDir: string, runId: string, command: RunControlCommand): Promise<RunControlState> {
  const state = await readRunControlState(outputDir, runId);
  if (!state) {
    throw new Error(`Run ${runId} has no available local control channel; it may have ended, or --output does not match`);
  }
  const socketPath = resolveSocketPath(state.socketPath);
  if (!socketPath) {
    await cleanupStaleRunState(outputDir, runId, state);
    throw new Error(`The control channel for run ${runId} is unavailable; stale run state was cleaned up. Restart the task.`);
  }

  let response: RunControlResponse;
  try {
    response = await requestControl(socketPath, command);
  } catch {
    await cleanupStaleRunState(outputDir, runId, state);
    throw new Error(`The control channel for run ${runId} is unavailable; stale run state was cleaned up. Restart the task.`);
  }
  if (!response.ok || !response.data) {
    throw new Error(response.error || `Failed to control run ${runId}`);
  }
  return response.data;
}

export async function readTaskControlState(taskId: string): Promise<RunControlState | null> {
  return readControlStateFile(taskControlFilePath(taskId), dirname(taskControlFilePath(taskId)));
}

export async function cleanupTaskControlState(taskId: string): Promise<RunControlState | null> {
  const state = await readTaskControlState(taskId);
  if (state) await cleanupStaleTaskState(state);
  return state;
}

export async function listActiveTaskControlStates(): Promise<RunControlState[]> {
  const dir = taskControlDir();
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const states: RunControlState[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const state = await readControlStateFile(join(dir, entry), dir);
    if (state && await isRunControlReachable(state)) states.push(state);
  }
  return states;
}

export async function readRunControlState(outputDir: string, runId: string): Promise<RunControlState | null> {
  return readControlStateFile(controlFilePath(join(outputDir, runId)), outputDir);
}

export function isRunControlAlive(state: RunControlState | null): boolean {
  return Boolean(state?.socketPath && resolveSocketPath(state.socketPath));
}

export async function isRunControlReachable(state: RunControlState | null): Promise<boolean> {
  const socketPath = state?.socketPath ? resolveSocketPath(state.socketPath) : null;
  if (!socketPath) return false;
  try {
    const response = await requestControl(socketPath, 'status', 500);
    return response.ok && Boolean(response.data);
  } catch {
    return false;
  }
}

export function resolveRunControlSocketPath(state: RunControlState): string | null {
  return resolveSocketPath(state.socketPath);
}

export async function cleanupTaskControlStates(): Promise<RunControlCleanupResult> {
  const dir = taskControlDir();
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return { checked: 0, alive: 0, removed: 0, orphaned: [] };
  }

  const result: RunControlCleanupResult = { checked: 0, alive: 0, removed: 0, orphaned: [] };
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const filePath = join(dir, entry);
    const state = await readControlStateFile(filePath, dirname(filePath));
    await cleanupControlFile(filePath, state, result);
  }
  return result;
}

export async function cleanupRunControlStates(outputDir: string): Promise<RunControlCleanupResult> {
  let entries: string[] = [];
  try {
    entries = await readdir(outputDir);
  } catch {
    return { checked: 0, alive: 0, removed: 0, orphaned: [] };
  }

  const result: RunControlCleanupResult = { checked: 0, alive: 0, removed: 0, orphaned: [] };
  for (const entry of entries) {
    const filePath = controlFilePath(join(outputDir, entry));
    if (!existsSync(filePath)) continue;
    const state = await readControlStateFile(filePath, outputDir);
    await cleanupControlFile(filePath, state, result);
    if (state && !(await isRunControlReachable(state))) {
      await unlinkTaskControlFile(state.taskId, state.socketPath).catch(() => undefined);
    }
  }
  return result;
}

async function readControlStateFile(filePath: string, fallbackOutputDir: string): Promise<RunControlState | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<RunControlState>;
    if (!parsed.runId || !parsed.lotId || !parsed.taskId || !parsed.socketPath || !parsed.status) return null;
    return {
      runId: parsed.runId,
      lotId: parsed.lotId,
      taskId: parsed.taskId,
      taskName: typeof parsed.taskName === 'string' ? parsed.taskName : undefined,
      pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
      socketPath: parsed.socketPath,
      status: parsed.status as ActiveRunStatus,
      outputDir: typeof parsed.outputDir === 'string' ? parsed.outputDir : fallbackOutputDir,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : ''
    };
  } catch {
    return null;
  }
}

export function controlStateToSummary(state: RunControlState): RunSummary {
  return {
    runId: state.runId,
    lotId: state.lotId,
    taskId: state.taskId,
    taskName: state.taskName,
    status: state.status,
    total: 0,
    outputDir: join(state.outputDir, state.runId),
    startedAt: state.updatedAt
  };
}

function controlFilePath(runDir: string): string {
  return join(runDir, 'control.json');
}

function taskControlFilePath(taskId: string): string {
  return join(taskControlDir(), `${safeSocketName(taskId)}.json`);
}

function taskControlDir(): string {
  return join(homedir(), '.octoparse', 'active-local');
}

async function cleanupControlFile(
  filePath: string,
  state: RunControlState | null,
  result: RunControlCleanupResult
): Promise<void> {
  result.checked += 1;
  if (await isRunControlReachable(state)) {
    result.alive += 1;
    return;
  }

  result.removed += 1;
  result.orphaned.push({
    filePath,
    taskId: state?.taskId,
    runId: state?.runId,
    socketPath: state?.socketPath,
    lastStatus: state?.status
  });
  await unlink(filePath).catch(() => undefined);
}

async function unlinkTaskControlFile(taskId: string, socketPath: string): Promise<void> {
  const filePath = taskControlFilePath(taskId);
  const state = await readControlStateFile(filePath, dirname(filePath));
  if (state?.socketPath === socketPath) {
    await unlink(filePath).catch(() => undefined);
  }
}

async function cleanupStaleTaskState(state: RunControlState): Promise<void> {
  await unlinkTaskControlFile(state.taskId, state.socketPath).catch(() => undefined);
  await unlink(state.socketPath).catch(() => undefined);
  await unlink(controlFilePath(join(state.outputDir, state.runId))).catch(() => undefined);
}

async function cleanupStaleRunState(outputDir: string, runId: string, state: RunControlState): Promise<void> {
  await unlink(controlFilePath(join(outputDir, runId))).catch(() => undefined);
  await unlinkTaskControlFile(state.taskId, state.socketPath).catch(() => undefined);
  await unlink(state.socketPath).catch(() => undefined);
}

function safeSocketName(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
}

function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12);
}

function resolveSocketPath(socketPath: string): string | null {
  if (existsSync(socketPath)) return socketPath;
  return null;
}

async function handleSocket(
  socket: Socket,
  handler: (command: RunControlCommand) => Promise<RunControlResponse>
): Promise<void> {
  let raw = '';
  let handled = false;
  socket.setEncoding('utf8');

  const respond = (response: RunControlResponse) => {
    socket.end(`${JSON.stringify(response)}\n`);
  };
  const handleRequest = () => {
    if (handled || !raw.trim()) return;
    handled = true;
    void (async () => {
      try {
        const parsed = JSON.parse(raw.trim()) as { command?: string };
        if (!isControlCommand(parsed.command)) {
          respond({ ok: false, error: 'invalid command' });
          return;
        }
        respond(await handler(parsed.command));
      } catch (error) {
        respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
  };

  socket.on('data', (chunk) => {
    raw += chunk;
    if (raw.includes('\n')) handleRequest();
  });
  socket.on('end', handleRequest);
}

function requestControl(socketPath: string, command: RunControlCommand, timeoutMs = 10_000): Promise<RunControlResponse> {
  return new Promise((resolve, reject) => {
    let raw = '';
    let settled = false;
    const socket = createConnection(socketPath);
    const timeout = setTimeout(() => {
      finish(new Error('Control channel response timed out'));
      socket.destroy();
    }, timeoutMs);

    const finish = (result: RunControlResponse | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ command })}\n`);
    });
    socket.on('data', (chunk) => {
      raw += chunk;
    });
    socket.on('error', (error) => finish(error));
    socket.on('end', () => {
      try {
        finish(JSON.parse(raw.trim()) as RunControlResponse);
      } catch {
        finish(new Error(`Control channel response is not valid JSON${raw ? `: ${raw.slice(0, 200)}` : ''}`));
      }
    });
    socket.on('close', () => {
      if (settled) return;
      if (!raw.trim()) {
        finish(new Error('Control channel did not respond'));
        return;
      }
      try {
        finish(JSON.parse(raw.trim()) as RunControlResponse);
      } catch {
        finish(new Error(`Control channel response is not valid JSON: ${raw.slice(0, 200)}`));
      }
    });
  });
}

function isControlCommand(value: unknown): value is RunControlCommand {
  return value === 'status' || value === 'pause' || value === 'resume' || value === 'stop';
}
