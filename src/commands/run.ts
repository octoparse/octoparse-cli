import { spawn } from 'node:child_process';
import { mkdir, open, readFile, writeFile, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hasFlag, parsePositiveInt, valueAfter } from '../cli/args.js';
import { printEnvelope, printUsageError } from '../cli/output.js';
import { resolveOPLocalRunPolicy } from '../runtime/account-capabilities.js';
import { ApiRequestError, fetchAccountInfo, fetchQuantityLimitSettings } from '../runtime/api-client.js';
import { appendJsonLine, ensureRunDir, writeRunSummary } from '../runtime/artifacts.js';
import { resolveAuth } from '../runtime/auth.js';
import { EngineHost } from '../runtime/engine-host.js';
import { defaultRunsDir } from '../runtime/local-runs.js';
import { safeFileName } from '../runtime/naming.js';
import {
  isRunControlReachable,
  listActiveTaskControlStates,
  readTaskControlState,
  startRunControlServer,
  type ActiveRunStatus,
  type RunControlServer
} from '../runtime/run-control.js';
import { TaskDefinitionProvider } from '../runtime/task-definition-provider.js';
import {
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  EXIT_RUNTIME_FAILED,
  type RunOptions,
  type RunSummary,
  type TaskDefinition
} from '../types.js';

const DETACHED_CHILD_ENV = 'OCTO_ENGINE_DETACHED_CHILD';
const DETACHED_BOOTSTRAP_DIR_ENV = 'OCTO_ENGINE_DETACHED_BOOTSTRAP_DIR';

export async function runTask(taskId: string | undefined, args: string[]): Promise<number> {
  const json = hasFlag([taskId ?? '', ...args], '--json') || hasFlag([taskId ?? '', ...args], '--jsonl');
  if (!taskId || taskId.startsWith('-')) {
    return printUsageError(
      json,
      'Error: missing taskId',
      'Usage: octoparse run <taskId> [--task-file <file.json|file.xml|file.otd>] [--output <dir>] [--chrome-path <path>] [--max-rows <n>] [--detach] [--json|--jsonl]'
    );
  }

  if (taskId === 'export') {
    return printUsageError(
      json,
      'run has no export subcommand; run only starts local extraction.',
      'Export data with: octoparse data export <taskId> [--source local|cloud] [--lot-id <lotId>] [--file <result.xlsx>] [--format xlsx|csv|html|json|xml]'
    );
  }

  if (hasFlag(args, '--format')) {
    const message = 'run does not support --format; use --json or --jsonl. Export data files with data export --format.';
    if (hasFlag(args, '--json') || hasFlag(args, '--jsonl')) {
      printEnvelope(false, undefined, 'RUN_FORMAT_UNSUPPORTED', message);
    } else {
      console.error(message);
    }
    return EXIT_OPERATION_FAILED;
  }

  const options = parseRunOptions(taskId, args);
  const maxRowsError = validateMaxRows(args);
  if (maxRowsError) {
    return printUsageError(
      options.json || options.jsonl,
      maxRowsError,
      'Usage: octoparse run <taskId> [--max-rows <positive integer>] [--json|--jsonl]',
      'RUN_MAX_ROWS_INVALID'
    );
  }

  const active = await readTaskControlState(taskId);
  if (await isRunControlReachable(active)) {
    const message = `Local extraction is already running: taskId=${taskId}, status=${active?.status}`;
    if (options.json || options.jsonl) printEnvelope(false, undefined, 'LOCAL_RUN_ALREADY_RUNNING', message);
    else console.error(message);
    return EXIT_OPERATION_FAILED;
  }

  if (process.env[DETACHED_CHILD_ENV] !== '1') {
    const limitExitCode = await enforceLocalRunLimit(args, options);
    if (limitExitCode !== EXIT_OK) return limitExitCode;
  }

  if (options.detach && process.env[DETACHED_CHILD_ENV] !== '1') {
    return startDetachedRun(taskId, args, options);
  }

  const provider = new TaskDefinitionProvider();
  return executeTask(taskId, options, () => provider.getTask(taskId, options.taskFile));
}

async function enforceLocalRunLimit(args: string[], options: RunOptions): Promise<number> {
  try {
    const auth = await resolveAuth();
    if (!auth.apiKey) return EXIT_OK;

    const baseUrl = valueAfter(args, '--api-base-url');
    const [account, limits] = await Promise.all([
      fetchAccountInfo({
        apiKey: auth.apiKey,
        baseUrl
      }),
      fetchQuantityLimitSettings({
        apiKey: auth.apiKey,
        baseUrl
      })
    ]);
    const policy = resolveOPLocalRunPolicy(account.data, limits.data);
    if (policy.maxActiveLocalRuns === undefined || policy.maxActiveLocalRuns === null) {
      return EXIT_OK;
    }

    const activeRuns = await listActiveTaskControlStates();
    if (activeRuns.length < policy.maxActiveLocalRuns) {
      return EXIT_OK;
    }

    const message = `Local extraction concurrency reached the current account limit (${policy.maxActiveLocalRuns}). Stop a running task before starting another.`;
    if (options.json || options.jsonl) {
      printEnvelope(false, undefined, 'LOCAL_RUN_LIMIT_EXCEEDED', message);
    } else {
      console.error(message);
    }
    return EXIT_OPERATION_FAILED;
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === 'AUTH_INVALID') {
      const message = error.message;
      if (options.json || options.jsonl) printEnvelope(false, undefined, error.code, message);
      else console.error(`Authentication failed: ${message}`);
      return EXIT_OPERATION_FAILED;
    }
    return EXIT_OK;
  }
}

async function startDetachedRun(taskId: string, args: string[], options: RunOptions): Promise<number> {
  const bootstrap = await createDetachedBootstrap(taskId, options.outputDir);
  const childArgs = [
    process.argv[1],
    'run',
    taskId,
    ...args.filter((arg) => arg !== '--detach')
  ];
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ['ignore', bootstrap.stdout.fd, bootstrap.stderr.fd],
    env: {
      ...process.env,
      [DETACHED_CHILD_ENV]: '1',
      [DETACHED_BOOTSTRAP_DIR_ENV]: bootstrap.dir
    },
    cwd: process.cwd()
  });
  await closeFileHandles(bootstrap.stdout, bootstrap.stderr);
  child.unref();

  await writeDetachedBootstrap(bootstrap.dir, {
    pid: child.pid,
    status: 'spawned',
    updatedAt: new Date().toISOString()
  });

  const startup = await waitForDetachedStartup(taskId, child, bootstrap.dir, 10_000);
  if (!startup.ok) {
    const message = `${startup.error ?? 'detached run failed before control channel became ready'}; bootstrap=${bootstrap.dir}`;
    if (options.json) printEnvelope(false, undefined, 'DETACHED_RUN_FAILED', message);
    else {
      console.error(`Detached run failed: ${startup.error ?? 'startup failed'}`);
      console.error(`Bootstrap: ${bootstrap.dir}`);
    }
    return EXIT_RUNTIME_FAILED;
  }

  const state = startup.state;
  if (!state) {
    await writeDetachedBootstrap(bootstrap.dir, {
      pid: child.pid,
      status: 'starting',
      updatedAt: new Date().toISOString()
    });
  }
  const data = {
    taskId,
    detached: true,
    pid: child.pid,
    status: state?.status ?? 'starting',
    outputDir: state?.outputDir,
    bootstrapDir: bootstrap.dir,
    stdout: bootstrap.stdoutPath,
    stderr: bootstrap.stderrPath
  };

  if (options.json) {
    printEnvelope(true, data);
  } else {
    console.log(`Local run started: ${taskId}`);
    console.log(`PID: ${child.pid}`);
    console.log(`Status: ${data.status}`);
    if (data.outputDir) console.log(`Output: ${data.outputDir}`);
    console.log(`Bootstrap: ${bootstrap.dir}`);
    console.log(`Control: octoparse local status ${taskId}`);
  }
  return EXIT_OK;
}

async function executeTask(
  taskId: string,
  options: RunOptions,
  loadTask: () => Promise<TaskDefinition>
): Promise<number> {
  const host = new EngineHost();
  let currentRunDir = '';
  let currentRunId = '';
  let currentLotId = '';
  let currentTaskName = '';
  let runDirReady: Promise<string> | null = null;
  let runStatus: ActiveRunStatus = 'running';
  let controlServer: RunControlServer | null = null;
  let controlServerReady: Promise<RunControlServer> | null = null;
  let artifactQueue = Promise.resolve();
  let signalHandler: (() => void) | null = null;
  let savedRows = 0;
  let rowLimitReached = false;
  let stopReason: string | undefined;
  const runtimeConsole = maybeSuppressRuntimeConsole(options);
  const detachedBootstrapDir = process.env[DETACHED_BOOTSTRAP_DIR_ENV];
  const startedAt = new Date().toISOString();

  const appendRunArtifact = (fileName: string, value: unknown) => {
    if (!runDirReady) return;
    artifactQueue = artifactQueue
      .then(async () => {
        const runDir = await runDirReady;
        if (!runDir) return;
        await appendJsonLine(join(runDir, fileName), value);
      })
      .catch(() => undefined);
  };
  const waitControlServer = async () => {
    const ready = controlServerReady as Promise<RunControlServer> | null;
    if (ready) await ready.catch(() => undefined);
  };
  const updateControlStatus = async (status: ActiveRunStatus) => {
    const server = controlServer as RunControlServer | null;
    if (server) await server.updateStatus(status).catch(() => undefined);
  };
  const closeControlServer = async () => {
    const server = controlServer as RunControlServer | null;
    if (server) await server.close().catch(() => undefined);
  };

  host.on('run.started', (event) => {
    currentRunId = event.runId;
    currentLotId = event.lotId;
    currentTaskName = event.taskName;
    currentRunDir = join(options.outputDir, event.runId);
    runDirReady = ensureRunDir(options.outputDir, event.runId);
    if (detachedBootstrapDir) {
      void writeDetachedBootstrap(detachedBootstrapDir, {
        status: 'running',
        runId: event.runId,
        lotId: event.lotId,
        taskId: event.taskId,
        taskName: event.taskName,
        outputDir: currentRunDir,
        updatedAt: new Date().toISOString()
      });
    }
    controlServerReady = runDirReady.then(async (runDir) => {
      const server = await startRunControlServer({
        runDir,
        outputDir: options.outputDir,
        runId: event.runId,
        lotId: event.lotId,
        taskId: event.taskId,
        taskName: event.taskName,
        onCommand: async (command) => {
          if (command === 'status') return runStatus;
          if (command === 'pause') {
            host.pause();
            runStatus = 'paused';
            appendRunArtifact('events.jsonl', { event: 'run.paused', runId: event.runId, taskId: event.taskId });
            if (options.jsonl) printRunJsonLine(runtimeConsole, { event: 'run.paused', runId: event.runId, taskId: event.taskId });
            return runStatus;
          }
          if (command === 'resume') {
            host.resume();
            runStatus = 'running';
            appendRunArtifact('events.jsonl', { event: 'run.resumed', runId: event.runId, taskId: event.taskId });
            if (options.jsonl) printRunJsonLine(runtimeConsole, { event: 'run.resumed', runId: event.runId, taskId: event.taskId });
            return runStatus;
          }
          host.stop();
          runStatus = 'stopping';
          appendRunArtifact('events.jsonl', { event: 'run.stopping', runId: event.runId, taskId: event.taskId });
          if (options.jsonl) printRunJsonLine(runtimeConsole, { event: 'run.stopping', runId: event.runId, taskId: event.taskId });
          return runStatus;
        }
      });
      controlServer = server;
      return server;
    });
    void controlServerReady.catch(() => undefined);
    appendRunArtifact('events.jsonl', { event: 'run.started', ...event });
    if (options.jsonl) printRunJsonLine(runtimeConsole, { event: 'run.started', ...event });
  });

  host.on('row', (event) => {
    if (options.maxRows !== undefined && savedRows >= options.maxRows) {
      if (!rowLimitReached) {
        rowLimitReached = true;
        stopReason = 'max_rows';
        runStatus = 'stopping';
        void updateControlStatus(runStatus);
        host.stop();
      }
      return;
    }

    savedRows += 1;
    const rowEvent = { ...event, total: savedRows };
    appendRunArtifact('rows.jsonl', event.data);
    appendRunArtifact('events.jsonl', { event: 'row', ...rowEvent });
    if (options.jsonl) printRunJsonLine(runtimeConsole, { event: 'row', ...rowEvent });

    if (options.maxRows !== undefined && savedRows >= options.maxRows && !rowLimitReached) {
      rowLimitReached = true;
      stopReason = 'max_rows';
      runStatus = 'stopping';
      void updateControlStatus(runStatus);
      appendRunArtifact('events.jsonl', {
        event: 'run.stopping',
        runId: event.runId,
        taskId,
        reason: stopReason,
        maxRows: options.maxRows,
        total: savedRows
      });
      if (options.jsonl) {
        printRunJsonLine(runtimeConsole, {
          event: 'run.stopping',
          runId: event.runId,
          taskId,
          reason: stopReason,
          maxRows: options.maxRows,
          total: savedRows
        });
      }
      host.stop();
    }
  });

  host.on('log', (event) => {
    appendRunArtifact('logs.jsonl', event);
    appendRunArtifact('events.jsonl', { event: 'log', ...event });
    if (options.jsonl) printRunJsonLine(runtimeConsole, { event: 'log', ...event });
    else if (!options.json && (options.debugBridge || event.message.startsWith('runtime.'))) {
      runtimeConsole.stderr(event.message);
    }
  });

  host.on('captcha', (event) => {
    appendRunArtifact('events.jsonl', { event: 'captcha', ...event });
    if (options.jsonl) printRunJsonLine(runtimeConsole, { event: 'captcha', ...event });
  });

  host.on('proxy', (event) => {
    appendRunArtifact('events.jsonl', { event: 'proxy', ...event });
    if (options.jsonl) printRunJsonLine(runtimeConsole, { event: 'proxy', ...event });
  });

  try {
    const task = await loadTask();

    let interruptCount = 0;
    const interrupted = new Promise<RunSummary>((resolveInterrupted) => {
      signalHandler = () => {
        interruptCount += 1;
        if (interruptCount > 1) {
          process.exit(130);
        }
        if (!options.json && !options.jsonl) {
          runtimeConsole.stderr('\nReceived Ctrl+C, stopping extraction...');
        }
        runStatus = 'stopping';
        stopReason = 'interrupt';
        void updateControlStatus(runStatus);
        host.stop();
        setTimeout(() => {
          resolveInterrupted({
            runId: currentRunId || `run_${safeFileName(task.taskId)}_interrupted`,
            lotId: currentLotId || 'lot_interrupted',
            taskId: task.taskId,
            taskName: currentTaskName || task.taskName,
            status: 'stopped',
            total: savedRows,
            outputDir: options.outputDir,
            startedAt,
            stoppedAt: new Date().toISOString(),
            stopReason
          });
        }, 3_000);
      };
      process.once('SIGINT', signalHandler);
    });

    const runPromise = withTimeout(host.start(task, options), options.runTimeoutMs, () => {
      runStatus = 'stopping';
      stopReason = 'timeout';
      void updateControlStatus(runStatus);
      host.stop();
      return `Run timeout after ${options.runTimeoutMs}ms`;
    });
    const summary = await Promise.race([runPromise, interrupted]);
    runPromise.catch(() => undefined);
    if (signalHandler) {
      process.off('SIGINT', signalHandler);
      signalHandler = null;
    }
    const runDir = currentRunDir || await ensureRunDir(options.outputDir, summary.runId);
    const finalSummary: RunSummary = {
      ...summary,
      total: savedRows || summary.total,
      ...(stopReason ? { stopReason } : {}),
      ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {})
    };
    runStatus = finalSummary.status;
    await waitControlServer();
    await updateControlStatus(runStatus);
    await artifactQueue;
    await writeRunSummary(runDir, { ...finalSummary, outputDir: runDir });
    await appendJsonLine(join(runDir, 'events.jsonl'), { event: 'run.stopped', ...finalSummary, outputDir: runDir });
    await closeControlServer();
    await host.close();
    if (detachedBootstrapDir) {
      await writeDetachedBootstrap(detachedBootstrapDir, {
        status: finalSummary.status,
        runId: finalSummary.runId,
        lotId: finalSummary.lotId,
        outputDir: runDir,
        total: finalSummary.total,
        stoppedAt: finalSummary.stoppedAt,
        updatedAt: new Date().toISOString()
      });
    }

    if (options.jsonl) {
      printRunJsonLine(runtimeConsole, { event: 'run.stopped', ...finalSummary, outputDir: runDir });
    } else if (options.json) {
      printRunEnvelope(runtimeConsole, true, { ...finalSummary, outputDir: runDir });
    } else {
      runtimeConsole.stdout(`Run completed: ${finalSummary.runId}`);
      runtimeConsole.stdout(`Task: ${finalSummary.taskId}`);
      runtimeConsole.stdout(`Rows: ${finalSummary.total}`);
      if (finalSummary.stopReason === 'max_rows') runtimeConsole.stdout(`Stop reason: max_rows (${finalSummary.maxRows})`);
      runtimeConsole.stdout(`Artifacts: ${runDir}`);
      runtimeConsole.stdout(`View data: ${localDataExportCommand(finalSummary)}`);
    }
    return EXIT_OK;
  } catch (error) {
    if (signalHandler) {
      process.off('SIGINT', signalHandler);
      signalHandler = null;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (currentRunDir && currentRunId) {
      runStatus = 'failed';
      await waitControlServer();
      await updateControlStatus(runStatus);
      await artifactQueue;
      await appendJsonLine(join(currentRunDir, 'events.jsonl'), {
        event: 'run.failed',
        runId: currentRunId,
        taskId,
        error: message
      }).catch(() => undefined);
      await closeControlServer();
    }
    await host.close();
    if (detachedBootstrapDir) {
      await writeDetachedBootstrap(detachedBootstrapDir, {
        status: 'failed',
        runId: currentRunId || undefined,
        taskId,
        outputDir: currentRunDir || undefined,
        error: message,
        updatedAt: new Date().toISOString()
      }).catch(() => undefined);
    }
    if (options.json || options.jsonl) {
      printRunEnvelope(runtimeConsole, false, undefined, 'ENGINE_RUN_FAILED', message);
    } else {
      runtimeConsole.stderr(`Run failed: ${message}`);
    }
    return EXIT_RUNTIME_FAILED;
  }
}

export function localDataExportCommand(summary: Pick<RunSummary, 'taskId' | 'lotId'>): string {
  return `octoparse data export ${summary.taskId} --source local --lot-id ${summary.lotId}`;
}

function parseRunOptions(taskId: string, args: string[]): RunOptions {
  return {
    taskId,
    taskFile: valueAfter(args, '--task-file'),
    outputDir: resolve(valueAfter(args, '--output') ?? defaultRunsDir()),
    headless: hasFlag(args, '--headless'),
    json: hasFlag(args, '--json'),
    jsonl: hasFlag(args, '--jsonl'),
    chromePath: valueAfter(args, '--chrome-path'),
    disableImage: hasFlag(args, '--disable-image'),
    disableAD: hasFlag(args, '--disable-ad'),
    runTimeoutMs: parsePositiveInt(valueAfter(args, '--timeout-ms'), 10 * 60 * 1000),
    extensionTimeoutMs: parsePositiveInt(valueAfter(args, '--extension-timeout-ms'), 15 * 1000),
    debugBridge: hasFlag(args, '--debug-bridge'),
    detach: hasFlag(args, '--detach'),
    maxRows: parseOptionalPositiveInt(valueAfter(args, '--max-rows'))
  };
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function validateMaxRows(args: string[]): string | null {
  if (!hasFlag(args, '--max-rows')) return null;
  const raw = valueAfter(args, '--max-rows');
  if (!raw || raw.startsWith('-')) return '--max-rows requires a positive integer';
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
    return '--max-rows requires a positive integer';
  }
  return null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(onTimeout())), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForDetachedStartup(
  taskId: string,
  child: ReturnType<typeof spawn>,
  bootstrapDir: string,
  timeoutMs: number
): Promise<{ ok: true; state: Awaited<ReturnType<typeof readTaskControlState>> } | { ok: false; error: string }> {
  let childExited = false;
  let childExitCode: number | null = null;
  let childExitSignal: NodeJS.Signals | null = null;
  child.once('exit', (code, signal) => {
    childExited = true;
    childExitCode = code;
    childExitSignal = signal;
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readTaskControlState(taskId);
    if (await isRunControlReachable(state)) return { ok: true, state };

    const bootstrap = await readDetachedBootstrap(bootstrapDir);
    if (bootstrap?.status === 'failed') {
      return { ok: false, error: String(bootstrap.error ?? 'child failed') };
    }
    if (childExited) {
      return {
        ok: false,
        error: `child exited early code=${childExitCode ?? ''} signal=${childExitSignal ?? ''}`.trim()
      };
    }
    await sleep(200);
  }
  return { ok: true, state: null };
}

interface DetachedBootstrap {
  taskId?: string;
  pid?: number;
  status?: string;
  runId?: string;
  lotId?: string;
  taskName?: string;
  outputDir?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
  total?: number;
  createdAt?: string;
  updatedAt?: string;
  stoppedAt?: string;
}

async function createDetachedBootstrap(taskId: string, outputDir: string): Promise<{
  dir: string;
  stdoutPath: string;
  stderrPath: string;
  stdout: FileHandle;
  stderr: FileHandle;
}> {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const dir = join(outputDir, `.detach_${safeFileName(taskId)}_${stamp}`);
  await mkdir(dir, { recursive: true });
  const stdoutPath = join(dir, 'stdout.log');
  const stderrPath = join(dir, 'stderr.log');
  const stdout = await open(stdoutPath, 'a');
  const stderr = await open(stderrPath, 'a');
  await writeDetachedBootstrap(dir, {
    taskId,
    status: 'spawning',
    stdout: stdoutPath,
    stderr: stderrPath,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  return { dir, stdoutPath, stderrPath, stdout, stderr };
}

async function closeFileHandles(...handles: FileHandle[]): Promise<void> {
  await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
}

async function readDetachedBootstrap(dir: string): Promise<DetachedBootstrap | null> {
  try {
    return JSON.parse(await readFile(join(dir, 'bootstrap.json'), 'utf8')) as DetachedBootstrap;
  } catch {
    return null;
  }
}

async function writeDetachedBootstrap(dir: string, patch: DetachedBootstrap): Promise<void> {
  await mkdir(dir, { recursive: true });
  const existing = await readDetachedBootstrap(dir) ?? {};
  const next = { ...existing, ...patch };
  await writeFile(join(dir, 'bootstrap.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

interface RuntimeConsole {
  stdout(line: string): void;
  stderr(line: string): void;
}

function maybeSuppressRuntimeConsole(options: RunOptions): RuntimeConsole {
  if (options.debugBridge || process.env.OCTOPARSE_SHOW_RUNTIME_STDIO === '1') return nativeRuntimeConsole();

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((..._args: unknown[]) => true) as typeof process.stdout.write;
  process.stderr.write = ((..._args: unknown[]) => true) as typeof process.stderr.write;

  return {
    stdout(line: string) {
      originalStdoutWrite(`${line}\n`);
    },
    stderr(line: string) {
      originalStderrWrite(`${line}\n`);
    }
  };
}

function printRunJsonLine(runtimeConsole: RuntimeConsole, value: unknown): void {
  runtimeConsole.stdout(JSON.stringify(value));
}

function nativeRuntimeConsole(): RuntimeConsole {
  return {
    stdout(line: string) {
      console.log(line);
    },
    stderr(line: string) {
      console.error(line);
    }
  };
}

function printRunEnvelope<T>(
  runtimeConsole: RuntimeConsole,
  ok: true,
  data: T
): void;
function printRunEnvelope(
  runtimeConsole: RuntimeConsole,
  ok: false,
  data: undefined,
  code: string,
  message: string
): void;
function printRunEnvelope<T>(
  runtimeConsole: RuntimeConsole,
  ok: boolean,
  data?: T,
  code?: string,
  message?: string
): void {
  const payload = ok
    ? { ok: true, data }
    : { ok: false, error: { code: code ?? 'ERROR', message: message ?? 'Unknown error' } };
  runtimeConsole.stdout(JSON.stringify(payload));
}
