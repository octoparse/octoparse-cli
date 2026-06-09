import { spawn } from 'node:child_process';
import { mkdir, open, readFile, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { hasFlag, parsePositiveInt, valueAfter } from '../cli/args.js';
import { printEnvelope, printUsageError } from '../cli/output.js';
import { appendJsonLine, ensureRunDir, writeRunSummary } from '../runtime/artifacts.js';
import { resolveAuth } from '../runtime/auth.js';
import {
  BillingPreflightError,
  checkPaidCapabilityPreflight,
  checkTemplateBillingPreflight,
  type BillingWarning
} from '../runtime/billing.js';
import { EngineHost, type RuntimeDownloadEvent } from '../runtime/engine-host.js';
import { defaultRunsDir } from '../runtime/local-runs.js';
import { safeFileName } from '../runtime/naming.js';
import { LINUX_ARM64_UNSUPPORTED_CODE, LINUX_ARM64_UNSUPPORTED_MESSAGE, isLocalChromeRuntimeSupported } from '../runtime/platform-support.js';
import { BillingRuntimeError } from '../runtime/run-services.js';
import { cookieHeaderFromSession, loadBrowserSession } from '../runtime/browser-session.js';
import {
  isRunControlReachable,
  listActiveTaskControlStates,
  readTaskControlState,
  startRunControlServer,
  type ActiveRunStatus,
  type RunControlServer
} from '../runtime/run-control.js';
import { TaskDefinitionProvider, transformXml } from '../runtime/task-definition-provider.js';
import {
  collectEndTrackingEvents,
  collectStartTrackingEvent,
  createTrackingClient,
  createTrackingRunContext,
  markTrackingRunStarted,
  markTrackingTaskLoaded,
  taskSettingsTrackingEvent
} from '../runtime/tracking.js';
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
const LOCAL_RUN_WARNING_THRESHOLD = 4;
const LOCAL_RUN_STRONG_WARNING_THRESHOLD = 6;
let engineHostFactory = () => new EngineHost();

export interface LocalRunResourceWarning {
  code: 'LOCAL_RUN_RESOURCE_WARNING';
  severity: 'warning' | 'strong_warning';
  activeLocalRuns: number;
  requestedLocalRuns: number;
  projectedLocalRuns: number;
  message: string;
}

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
  if (!isLocalChromeRuntimeSupported()) {
    if (options.json || options.jsonl) printEnvelope(false, undefined, LINUX_ARM64_UNSUPPORTED_CODE, LINUX_ARM64_UNSUPPORTED_MESSAGE);
    else console.error(LINUX_ARM64_UNSUPPORTED_MESSAGE);
    return EXIT_RUNTIME_FAILED;
  }

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

  const resourceWarning = process.env[DETACHED_CHILD_ENV] !== '1'
    ? await resolveLocalRunResourceWarning(1)
    : undefined;

  if (options.detach && process.env[DETACHED_CHILD_ENV] !== '1') {
    printLocalRunResourceWarning(options, resourceWarning);
    return startDetachedRun(taskId, args, options, resourceWarning);
  }

  printLocalRunResourceWarning(options, resourceWarning);
  const provider = new TaskDefinitionProvider();
  return executeTask(taskId, options, () => provider.getTask(taskId, options.taskFile), resourceWarning);
}

async function resolveLocalRunResourceWarning(requestedLocalRuns: number): Promise<LocalRunResourceWarning | undefined> {
  const activeRuns = await listActiveTaskControlStates();
  return buildLocalRunResourceWarning(activeRuns.length, requestedLocalRuns);
}

export function buildLocalRunResourceWarning(
  activeLocalRuns: number,
  requestedLocalRuns: number
): LocalRunResourceWarning | undefined {
  const projectedLocalRuns = activeLocalRuns + requestedLocalRuns;
  if (projectedLocalRuns < LOCAL_RUN_WARNING_THRESHOLD) return undefined;

  const severity = projectedLocalRuns >= LOCAL_RUN_STRONG_WARNING_THRESHOLD ? 'strong_warning' : 'warning';
  return {
    code: 'LOCAL_RUN_RESOURCE_WARNING',
    severity,
    activeLocalRuns,
    requestedLocalRuns,
    projectedLocalRuns,
    message: [
      `${activeLocalRuns} local extraction task${activeLocalRuns === 1 ? ' is' : 's are'} already running; `,
      `starting this task will bring the total to ${projectedLocalRuns}. `,
      'Each task starts an independent Chrome process. Too many local runs can consume significant memory and CPU, ',
      'slow extraction, crash browser pages, or make the system unresponsive. ',
      'Consider stopping tasks you no longer need with octoparse local status and octoparse local stop.'
    ].join('')
  };
}

function printLocalRunResourceWarning(options: RunOptions, warning: LocalRunResourceWarning | undefined): void {
  if (!warning) return;
  if (options.json) return;
  if (options.jsonl) {
    printEnvelopeLikeJsonLine({
      event: 'warning',
      code: warning.code,
      severity: warning.severity,
      activeLocalRuns: warning.activeLocalRuns,
      requestedLocalRuns: warning.requestedLocalRuns,
      projectedLocalRuns: warning.projectedLocalRuns,
      message: warning.message
    });
    return;
  }
  console.error(`Warning: ${warning.message}`);
}

function printEnvelopeLikeJsonLine(value: unknown): void {
  console.log(JSON.stringify(value));
}

async function startDetachedRun(
  taskId: string,
  args: string[],
  options: RunOptions,
  resourceWarning?: LocalRunResourceWarning
): Promise<number> {
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
    stderr: bootstrap.stderrPath,
    warnings: resourceWarning ? [resourceWarning] : []
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
  loadTask: () => Promise<TaskDefinition>,
  resourceWarning?: LocalRunResourceWarning
): Promise<number> {
  const host = engineHostFactory();
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
  let captchaRequests = 0;
  let proxyRequests = 0;
  let rowLimitReached = false;
  let stopReason: string | undefined;
  const runtimeConsole = maybeSuppressRuntimeConsole(options);
  const detachedBootstrapDir = process.env[DETACHED_BOOTSTRAP_DIR_ENV];
  const startedAt = new Date().toISOString();
  const auth = await resolveAuth().catch(() => undefined);
  const tracking = createTrackingClient({ authSource: auth?.source });
  const trackingRun = createTrackingRunContext({
    taskId,
    runOptions: options,
    billingWarningCount: 0
  });
  let trackingStartSent = false;
  let loadedTask: TaskDefinition | null = null;
  let billingWarnings: BillingWarning[] = [];
  let downloadStats: RunSummary['downloads'] | undefined;
  let rowQueue = Promise.resolve();

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
    if (server) await server.updateStatus(status, downloadStats).catch(() => undefined);
  };
  const closeControlServer = async () => {
    const server = controlServer as RunControlServer | null;
    if (server) await server.close().catch(() => undefined);
  };

  host.on('run.started', (event) => {
    currentRunId = event.runId;
    currentLotId = event.lotId;
    currentTaskName = event.taskName;
    markTrackingRunStarted(trackingRun, event);
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
    for (const warning of billingWarnings) {
      appendRunArtifact('events.jsonl', { event: 'billing.warning', ...warning });
    }
    if (options.jsonl) printRunJsonLine(runtimeConsole, { event: 'run.started', ...event });
    if (loadedTask) {
      tracking.sendMany([
        collectStartTrackingEvent(trackingRun, true),
        taskSettingsTrackingEvent(trackingRun, loadedTask)
      ]);
      trackingStartSent = true;
    }
  });

  host.on('row', (event) => {
    rowQueue = rowQueue
      .then(() => handleRowEvent(event))
      .catch((error) => {
        appendRunArtifact('events.jsonl', {
          event: 'log',
          runId: event.runId,
          level: 'error',
          message: `row processing failed: ${error instanceof Error ? error.message : String(error)}`
        });
      });
  });

  host.on('download', (event) => {
    downloadStats = updateEngineDownloadStats(downloadStats, event);
    const downloadEvent = {
      event: event.status === 'failed' ? 'download.failed' : event.status === 'success' ? 'download.succeeded' : 'download.started',
      runId: event.runId,
      item: {
        url: event.url,
        path: event.filePath,
        size: event.fileSize,
        fromField: event.fieldName,
        rowUuid: event.rowUuid,
        status: event.status,
        errorInfo: event.error
      },
      stats: downloadStats
    };
    appendRunArtifact('downloads.jsonl', downloadEvent);
    appendRunArtifact('events.jsonl', downloadEvent);
    if (options.jsonl) printRunJsonLine(runtimeConsole, downloadEvent);
    void updateControlStatus(runStatus);
  });

  const handleRowEvent = async (event: { runId: string; total: number; data: Record<string, unknown> }) => {
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
    const rowData = event.data;
    const rowEvent = { ...event, total: savedRows, data: rowData };
    appendRunArtifact('rows.jsonl', rowData);
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
  };

  host.on('log', (event) => {
    appendRunArtifact('logs.jsonl', event);
    appendRunArtifact('events.jsonl', { event: 'log', ...event });
    if (options.jsonl) printRunJsonLine(runtimeConsole, { event: 'log', ...event });
    else if (!options.json && (options.debugBridge || event.message.startsWith('runtime.'))) {
      runtimeConsole.stderr(event.message);
    }
  });

  host.on('captcha', (event) => {
    if (event.phase === 'requested') captchaRequests += 1;
    appendRunArtifact('events.jsonl', { event: 'captcha', ...event });
    if (options.jsonl) printRunJsonLine(runtimeConsole, { event: 'captcha', ...event });
  });

  host.on('proxy', (event) => {
    if (event.phase === 'requested') proxyRequests += 1;
    appendRunArtifact('events.jsonl', { event: 'proxy', ...event });
    if (options.jsonl) printRunJsonLine(runtimeConsole, { event: 'proxy', ...event });
  });

  host.on('billing.error', (event) => {
    appendRunArtifact('events.jsonl', { event: 'billing.error', ...event });
    if (options.jsonl) printRunJsonLine(runtimeConsole, { event: 'billing.error', ...event });
    else if (!options.json) runtimeConsole.stderr(`Billing error: ${event.message}`);
  });

  try {
    const task = await loadTask();
    await applyTaskBrowserSession(task, options, runtimeConsole);
    loadedTask = task;
    markTrackingTaskLoaded(trackingRun, task);
    billingWarnings = [
      ...(await checkTemplateBillingPreflight(task)),
      ...(await checkPaidCapabilityPreflight(task))
    ];
    trackingRun.billingWarningCount = billingWarnings.length;
    printBillingWarnings(options, runtimeConsole, billingWarnings);

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
    await rowQueue;
    if (downloadStats?.total) downloadStats = { ...downloadStats, status: 'completed' };
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
      ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
      ...(downloadStats ? { downloads: downloadStats } : {})
    };
    runStatus = finalSummary.status;
    await waitControlServer();
    await updateControlStatus(runStatus);
    await artifactQueue;
    await writeRunSummary(runDir, { ...finalSummary, outputDir: runDir });
    await appendJsonLine(join(runDir, 'events.jsonl'), { event: 'run.stopped', ...finalSummary, outputDir: runDir });
    await closeControlServer();
    await host.close();
    const trackingEndWay = finalSummary.status === 'completed' || finalSummary.stopReason === 'max_rows' ? 'finish' : 'manual';
    tracking.sendMany(collectEndTrackingEvents(trackingRun, {
      status: finalSummary.status,
      endWay: trackingEndWay,
      success: finalSummary.status === 'completed' || finalSummary.status === 'stopped',
      failReason: finalSummary.stopReason ?? '',
      total: finalSummary.total,
      stoppedAt: finalSummary.stoppedAt,
      useCaptchaCount: captchaRequests,
      useProxyCount: proxyRequests
    }));
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
      printRunEnvelope(runtimeConsole, true, {
        ...finalSummary,
        outputDir: runDir,
        warnings: [...(resourceWarning ? [resourceWarning] : []), ...billingWarnings],
        usage: {
          captchaRequests,
          proxyRequests
        }
      });
    } else {
      runtimeConsole.stdout(`Run completed: ${finalSummary.runId}`);
      runtimeConsole.stdout(`Task: ${finalSummary.taskId}`);
      runtimeConsole.stdout(`Rows: ${finalSummary.total}`);
      if (downloadStats) runtimeConsole.stdout(`Downloads: ${downloadStats.succeeded}/${downloadStats.total} succeeded, ${downloadStats.failed} failed`);
      if (downloadStats?.outputDir) runtimeConsole.stdout(`Download files: ${downloadStats.outputDir}`);
      if (finalSummary.stopReason === 'max_rows') runtimeConsole.stdout(`Stop reason: max_rows (${finalSummary.maxRows})`);
      runtimeConsole.stdout(`View data: ${localDataExportCommand(finalSummary)}`);
    }
    return EXIT_OK;
  } catch (error) {
    if (signalHandler) {
      process.off('SIGINT', signalHandler);
      signalHandler = null;
    }
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = runErrorCode(error);
    if (currentRunDir && currentRunId) {
      runStatus = 'failed';
      await waitControlServer();
      await updateControlStatus(runStatus);
      await artifactQueue;
      await appendJsonLine(join(currentRunDir, 'events.jsonl'), {
        event: 'run.failed',
        runId: currentRunId,
        taskId,
        code: errorCode,
        status: error instanceof BillingRuntimeError ? error.status : undefined,
        error: message
      }).catch(() => undefined);
      await closeControlServer();
    }
    await host.close();
    const trackingEndEvents = collectEndTrackingEvents(trackingRun, {
      status: 'failed',
      endWay: 'manual',
      success: false,
      failReason: message,
      total: savedRows,
      stoppedAt: new Date().toISOString(),
      useCaptchaCount: captchaRequests,
      useProxyCount: proxyRequests
    });
    tracking.sendMany(trackingStartSent
      ? trackingEndEvents
      : [collectStartTrackingEvent(trackingRun, false, message), ...trackingEndEvents]);
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
      printRunEnvelope(runtimeConsole, false, undefined, errorCode, message);
    } else {
      runtimeConsole.stderr(`Run failed: ${message}`);
    }
    return EXIT_RUNTIME_FAILED;
  }
}

function updateEngineDownloadStats(
  current: RunSummary['downloads'] | undefined,
  event: RuntimeDownloadEvent
): RunSummary['downloads'] {
  const outputDir = resolveDownloadOutputDir(current?.outputDir, event.filePath);
  const downloading = Math.max(
    0,
    (current?.downloading ?? 0) + (event.status === 'downloading' ? 1 : event.status === 'success' || event.status === 'failed' ? -1 : 0)
  );
  const succeeded = (current?.succeeded ?? 0) + (event.status === 'success' ? 1 : 0);
  const failed = (current?.failed ?? 0) + (event.status === 'failed' ? 1 : 0);
  const completed = succeeded + failed + (current?.canceled ?? 0);
  const total = Math.max(current?.total ?? 0, completed + downloading);
  return {
    status: 'downloading',
    outputDir,
    total,
    pending: 0,
    downloading,
    succeeded,
    failed,
    canceled: current?.canceled ?? 0,
    completed
  };
}

function resolveDownloadOutputDir(current: string | undefined, filePath: string): string | undefined {
  if (!filePath) return current;
  const next = dirname(filePath);
  if (!current) return next;
  if (current === next) return current;
  return commonPathPrefix(current, next);
}

function commonPathPrefix(left: string, right: string): string {
  const separator = left.includes('\\') || right.includes('\\') ? '\\' : '/';
  const leftParts = left.split(/[\\/]/);
  const rightParts = right.split(/[\\/]/);
  const common: string[] = [];
  const length = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    if (leftParts[index] !== rightParts[index]) break;
    common.push(leftParts[index]);
  }
  return common.join(separator) || left;
}

export function localDataExportCommand(summary: Pick<RunSummary, 'taskId' | 'lotId'>): string {
  return `octoparse data export ${summary.taskId} --source local --lot-id ${summary.lotId}`;
}

export function setEngineHostFactoryForTesting(factory: (() => EngineHost) | undefined): void {
  engineHostFactory = factory ?? (() => new EngineHost());
}

function printBillingWarnings(
  options: RunOptions,
  runtimeConsole: ReturnType<typeof maybeSuppressRuntimeConsole>,
  warnings: BillingWarning[]
): void {
  for (const warning of warnings) {
    if (options.json) continue;
    if (options.jsonl) {
      printRunJsonLine(runtimeConsole, { event: 'billing.warning', ...warning });
    } else {
      runtimeConsole.stderr(`Warning: ${warning.message}`);
    }
  }
}

function runErrorCode(error: unknown): string {
  if (error instanceof BillingPreflightError) return error.code;
  if (error instanceof BillingRuntimeError) return error.code;
  return 'ENGINE_RUN_FAILED';
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

async function applyTaskBrowserSession(
  task: TaskDefinition,
  options: RunOptions,
  runtimeConsole: ReturnType<typeof maybeSuppressRuntimeConsole>
): Promise<void> {
  const sessionName = task.recognition?.session?.name;
  if (!sessionName) return;
  const session = await loadBrowserSession(sessionName);
  const cookieHeader = cookieHeaderFromSession(session);
  if (!cookieHeader) {
    throw new Error(`Task requires browser session ${sessionName}, but the local session has no usable cookies`);
  }
  task.xml = injectGlobalCookie(task.xml, cookieHeader);
  task.xoml = await transformXml(task.xml);
  if (!options.json && !options.jsonl) {
    runtimeConsole.stderr(`Using browser session: ${session.name} (${session.cookieCount} cookies, cookies-only)`);
  }
}

export function injectGlobalCookie(xml: string, cookieHeader: string): string {
  const escaped = escapeXmlAttr(cookieHeader);
  const rootMatch = xml.match(/<[A-Za-z_][\w:.-]*(?:\s[^>]*)?>/);
  return replaceRootCookieAttrs(xml, rootMatch?.[0] ?? '', escaped);
}

function replaceRootCookieAttrs(xml: string, rootTag: string, escapedCookieHeader: string): string {
  if (!rootTag) throw new Error('task xml is missing a root node, cannot inject browser session cookies');
  let nextRoot = rootTag;
  if (/\bglobalCookie="[^"]*"/i.test(nextRoot)) {
    nextRoot = nextRoot.replace(/\bglobalCookie="[^"]*"/i, `globalCookie="${escapedCookieHeader}"`);
  } else {
    nextRoot = insertRootAttr(nextRoot, `globalCookie="${escapedCookieHeader}"`);
  }
  if (/\bisSetGlobalCookie="[^"]*"/i.test(nextRoot)) {
    nextRoot = nextRoot.replace(/\bisSetGlobalCookie="[^"]*"/i, 'isSetGlobalCookie="true"');
  } else {
    nextRoot = insertRootAttr(nextRoot, 'isSetGlobalCookie="true"');
  }
  if (nextRoot === rootTag) throw new Error('task xml root node cannot accept browser session cookies');
  return xml.replace(rootTag, nextRoot);
}

function insertRootAttr(rootTag: string, attr: string): string {
  if (/\/>$/.test(rootTag)) return rootTag.replace(/\s*\/>$/, ` ${attr} />`);
  return rootTag.replace(/>$/, ` ${attr}>`);
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
