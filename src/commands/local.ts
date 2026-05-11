import { resolve } from 'node:path';
import { firstPositionalArg, hasFlag, valueAfter } from '../cli/args.js';
import { printEnvelope, printUsageError } from '../cli/output.js';
import { localExport, localHistory } from './data.js';
import { ensureRunDir, listRuns, writeRunSummary } from '../runtime/artifacts.js';
import {
  cleanupTaskControlState,
  cleanupTaskControlStates,
  isRunControlReachable,
  readTaskControlState,
  resolveRunControlSocketPath,
  sendTaskControlCommand
} from '../runtime/run-control.js';
import { countRunRows, defaultRunsDir } from '../runtime/local-runs.js';
import { EXIT_OK, EXIT_OPERATION_FAILED, type RunSummary } from '../types.js';

export async function localCommand(subcommand: string | undefined, args: string[]): Promise<number> {
  const json = hasFlag([subcommand ?? '', ...args], '--json');
  if (subcommand === 'status') {
    return localStatus(args);
  }

  if (subcommand === 'history') {
    return localHistory(args);
  }

  if (subcommand === 'export') {
    return localExport(args);
  }

  if (subcommand === 'cleanup') {
    return localCleanup(args);
  }

  if (subcommand === 'pause' || subcommand === 'resume' || subcommand === 'stop') {
    return localControl(subcommand, args);
  }

  return printUsageError(json, 'Error: invalid local subcommand', 'Usage: octoparse local <status|pause|resume|stop|history|export|cleanup> <taskId> [--json]');
}

async function localStatus(args: string[]): Promise<number> {
  const taskId = firstPositionalArg(args, ['--output']);
  const json = hasFlag(args, '--json');
  if (!taskId) {
    return printUsageError(json, 'Error: missing taskId', 'Usage: octoparse local status <taskId> [--output <dir>] [--json]');
  }

  const state = await readTaskControlState(taskId);
  const alive = await isRunControlReachable(state);
  const actualSocketPath = state ? resolveRunControlSocketPath(state) : null;
  const total = state ? await countRunRows(state.outputDir, state.runId) : 0;
  const outputDir = resolve(state?.outputDir ?? valueAfter(args, '--output') ?? defaultRunsDir());
  const staleRun = state && !alive ? await preserveStaleRunSummary(state, total) : null;
  const lastRun = staleRun ?? await findLastLocalRun(outputDir, taskId);
  const currentRun = alive && state ? controlStateToPublicRun(state, total, actualSocketPath) : null;
  const data = alive && state
    ? {
        ...state,
        active: true,
        status: state.status,
        total,
        controlSocketPath: actualSocketPath,
        currentRun,
        lastRun
      }
    : state
      ? {
          taskId,
          active: false,
          status: 'not_running',
          currentRun: null,
          lastRun,
          cleanedStaleState: true,
          lastStatus: state.status,
          lastRunId: state.runId,
          total
        }
      : {
          taskId,
          active: false,
          status: 'not_running',
          currentRun: null,
          lastRun
        };
  if (state && !alive) {
    await cleanupTaskControlState(taskId);
  }

  if (json) {
    printEnvelope(true, data);
  } else if (alive && state) {
    console.log(`${taskId}  ${state?.status}`);
    console.log(`PID: ${state?.pid}`);
    console.log(`Rows: ${total}`);
    console.log(`Output: ${state?.outputDir}`);
    if (actualSocketPath && actualSocketPath !== state.socketPath) {
      console.log(`Control socket: ${actualSocketPath}`);
    }
  } else if (state) {
    console.log(`${taskId}  idle`);
    console.log(`Cleaned stale local state from previous run: ${state.runId}`);
    printLastRun(lastRun);
    console.log(`Rows: ${total}`);
  } else {
    console.log(`${taskId}  idle`);
    printLastRun(lastRun);
  }
  return EXIT_OK;
}

async function preserveStaleRunSummary(state: Awaited<ReturnType<typeof readTaskControlState>>, total: number): Promise<RunSummary | null> {
  if (!state) return null;
  const runDir = await ensureRunDir(state.outputDir, state.runId);
  const summary: RunSummary = {
    runId: state.runId,
    lotId: state.lotId,
    taskId: state.taskId,
    taskName: state.taskName,
    status: 'stopped',
    total,
    outputDir: runDir,
    startedAt: state.updatedAt,
    stoppedAt: new Date().toISOString()
  };
  await writeRunSummary(runDir, summary).catch(() => undefined);
  return summary;
}

async function findLastLocalRun(outputDir: string, taskId: string): Promise<RunSummary | null> {
  const runs = await listRuns(outputDir);
  return runs.find((run) => run.taskId === taskId) ?? null;
}

function controlStateToPublicRun(
  state: NonNullable<Awaited<ReturnType<typeof readTaskControlState>>>,
  total: number,
  controlSocketPath: string | null
) {
  return {
    runId: state.runId,
    lotId: state.lotId,
    taskId: state.taskId,
    taskName: state.taskName,
    status: state.status,
    total,
    outputDir: state.outputDir,
    pid: state.pid,
    controlSocketPath,
    updatedAt: state.updatedAt
  };
}

function printLastRun(lastRun: RunSummary | null): void {
  if (!lastRun) return;
  const lot = lastRun.lotId ? `  lot=${lastRun.lotId}` : '';
  console.log(`Last run: ${lastRun.status}  rows=${lastRun.total}${lot}`);
}

async function localControl(command: 'pause' | 'resume' | 'stop', args: string[]): Promise<number> {
  const taskId = firstPositionalArg(args);
  const json = hasFlag(args, '--json');
  if (!taskId) {
    return printUsageError(json, 'Error: missing taskId', `Usage: octoparse local ${command} <taskId> [--json]`);
  }

  try {
    const state = await sendTaskControlCommand(taskId, command);
    if (json) {
      printEnvelope(true, state);
    } else {
      console.log(`${taskId} ${command} -> ${state.status}`);
    }
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) printEnvelope(false, undefined, 'LOCAL_RUN_CONTROL_FAILED', message);
    else console.error(`Local extraction control failed: ${message}`);
    return EXIT_OPERATION_FAILED;
  }
}

async function localCleanup(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const result = await cleanupTaskControlStates();

  if (json) {
    printEnvelope(true, result);
  } else {
    console.log(`Checked: ${result.checked}`);
    console.log(`Alive: ${result.alive}`);
    console.log(`Removed orphaned: ${result.removed}`);
    for (const item of result.orphaned) {
      console.log(`  ${item.taskId ?? 'unknown-task'} ${item.runId ?? 'unknown-run'} ${item.filePath}`);
    }
  }
  return EXIT_OK;
}
