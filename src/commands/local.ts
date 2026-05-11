import { firstPositionalArg, hasFlag } from '../cli/args.js';
import { printEnvelope, printUsageError } from '../cli/output.js';
import { localExport, localHistory } from './data.js';
import { ensureRunDir, writeRunSummary } from '../runtime/artifacts.js';
import {
  cleanupTaskControlState,
  cleanupTaskControlStates,
  isRunControlReachable,
  readTaskControlState,
  resolveRunControlSocketPath,
  sendTaskControlCommand
} from '../runtime/run-control.js';
import { countRunRows } from '../runtime/local-runs.js';
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
  const taskId = firstPositionalArg(args);
  const json = hasFlag(args, '--json');
  if (!taskId) {
    return printUsageError(json, 'Error: missing taskId', 'Usage: octoparse local status <taskId> [--json]');
  }

  const state = await readTaskControlState(taskId);
  const alive = await isRunControlReachable(state);
  const actualSocketPath = state ? resolveRunControlSocketPath(state) : null;
  const total = state ? await countRunRows(state.outputDir, state.runId) : 0;
  const data = alive
    ? { ...state, total, controlSocketPath: actualSocketPath }
    : state
      ? { taskId, status: 'not_running', cleanedStaleState: true, lastStatus: state.status, lastRunId: state.runId, total }
      : { taskId, status: 'not_running' };
  if (state && !alive) {
    await preserveStaleRunSummary(state, total);
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
    console.log(`${taskId}  not_running`);
    console.log(`Cleaned stale local state from previous run: ${state.runId}`);
    console.log(`Last status: ${state.status}`);
    console.log(`Rows: ${total}`);
  } else {
    console.log(`${taskId}  not_running`);
  }
  return EXIT_OK;
}

async function preserveStaleRunSummary(state: Awaited<ReturnType<typeof readTaskControlState>>, total: number): Promise<void> {
  if (!state) return;
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
