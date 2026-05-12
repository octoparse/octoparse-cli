import { join, resolve } from 'node:path';
import { firstPositionalArg, hasFlag, parsePositiveInt, valueAfter } from '../cli/args.js';
import { printEnvelope, printMissingRun, printUsageError } from '../cli/output.js';
import { listRuns } from '../runtime/artifacts.js';
import { exportRowsToFile, normalizeDataExportFormat } from '../runtime/data-exporter.js';
import {
  defaultRunsDir,
  listActiveRuns,
  readActiveRunSummary,
  readJsonLines,
  runArtifactExists,
  readRunSummary,
  runMetaExists
} from '../runtime/local-runs.js';
import { cleanupRunControlStates, sendRunControlCommand } from '../runtime/run-control.js';
import { EXIT_OK, EXIT_OPERATION_FAILED } from '../types.js';

export async function runsList(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const outputDir = valueAfter(args, '--output') ?? defaultRunsDir();
  const runs = await listRuns(resolve(outputDir));
  const activeRuns = await listActiveRuns(resolve(outputDir));
  const knownRunIds = new Set(runs.map((run) => run.runId));
  for (const run of activeRuns) {
    if (!knownRunIds.has(run.runId)) runs.push(run);
  }
  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  if (json) {
    printEnvelope(true, runs);
    return EXIT_OK;
  }

  if (!runs.length) {
    console.log('No local runs found');
    return EXIT_OK;
  }

  console.log(`Local runs (${runs.length}):\n`);
  for (const run of runs) {
    console.log(`  ${run.runId}  ${run.status}  ${run.taskId}  rows=${run.total}  ${run.startedAt}`);
  }
  return EXIT_OK;
}

export async function runsCleanup(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const outputDir = resolve(valueAfter(args, '--output') ?? defaultRunsDir());
  const result = await cleanupRunControlStates(outputDir);

  if (json) {
    printEnvelope(true, { outputDir, ...result });
  } else {
    console.log(`Output: ${outputDir}`);
    console.log(`Checked: ${result.checked}`);
    console.log(`Alive: ${result.alive}`);
    console.log(`Removed orphaned: ${result.removed}`);
    for (const item of result.orphaned) {
      console.log(`  ${item.runId ?? 'unknown-run'} ${item.taskId ?? 'unknown-task'} ${item.filePath}`);
    }
  }
  return EXIT_OK;
}

export async function runsStatus(args: string[]): Promise<number> {
  const runId = firstPositionalArg(args, ['--output']);
  const json = hasFlag(args, '--json');
  const outputDir = resolve(valueAfter(args, '--output') ?? defaultRunsDir());
  if (!runId) {
    return printUsageError(json, 'Error: missing runId', 'Usage: octoparse runs status <runId> [--output <dir>] [--json]');
  }

  const summary = await readRunSummary(outputDir, runId) ?? await readActiveRunSummary(outputDir, runId);
  if (!summary) {
    return printMissingRun(json, runId);
  }

  if (json) {
    printEnvelope(true, summary);
  } else {
    console.log(`${summary.runId}  ${summary.status}  ${summary.taskId}  rows=${summary.total}`);
    console.log(`Artifacts: ${summary.outputDir}`);
  }
  return EXIT_OK;
}

export async function runsControl(command: 'pause' | 'resume' | 'stop', args: string[]): Promise<number> {
  const runId = firstPositionalArg(args, ['--output']);
  const json = hasFlag(args, '--json');
  const outputDir = resolve(valueAfter(args, '--output') ?? defaultRunsDir());
  if (!runId) {
    return printUsageError(json, 'Error: missing runId', `Usage: octoparse runs ${command} <runId> [--output <dir>] [--json]`);
  }

  try {
    const state = await sendRunControlCommand(outputDir, runId, command);
    if (json) {
      printEnvelope(true, state);
    } else {
      console.log(`${runId} ${command} -> ${state.status}`);
    }
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) printEnvelope(false, undefined, 'RUN_CONTROL_FAILED', message);
    else console.error(`Run control failed: ${message}`);
    return EXIT_OPERATION_FAILED;
  }
}

export async function runsLogs(args: string[]): Promise<number> {
  const runId = firstPositionalArg(args, ['--output', '--limit']);
  const json = hasFlag(args, '--json');
  const outputDir = resolve(valueAfter(args, '--output') ?? defaultRunsDir());
  const limit = parsePositiveInt(valueAfter(args, '--limit'), 100);
  if (!runId) {
    return printUsageError(json, 'Error: missing runId', 'Usage: octoparse runs logs <runId> [--output <dir>] [--limit 100] [--json]');
  }

  const runDir = join(outputDir, runId);
  if (!runArtifactExists(outputDir, runId)) {
    return printMissingRun(json, runId);
  }
  const logs = await readJsonLines(join(runDir, 'logs.jsonl'), limit);
  if (json) {
    printEnvelope(true, logs);
  } else {
    for (const item of logs) {
      const log = item as Record<string, unknown>;
      console.log(`[${String(log.level ?? 'info')}] ${String(log.message ?? '')}`);
    }
  }
  return EXIT_OK;
}

export async function runsData(args: string[]): Promise<number> {
  const runId = firstPositionalArg(args, ['--output', '--limit']);
  const json = hasFlag(args, '--json');
  const outputDir = resolve(valueAfter(args, '--output') ?? defaultRunsDir());
  const limit = parsePositiveInt(valueAfter(args, '--limit'), 100);
  if (!runId) {
    return printUsageError(json, 'Error: missing runId', 'Usage: octoparse runs data <runId> [--output <dir>] [--limit 100] [--json]');
  }

  const runDir = join(outputDir, runId);
  if (!runArtifactExists(outputDir, runId)) {
    return printMissingRun(json, runId);
  }
  const rows = await readJsonLines(join(runDir, 'rows.jsonl'), limit);
  if (json) {
    printEnvelope(true, rows);
  } else if (!rows.length) {
    console.log('No data rows');
  } else {
    for (const row of rows) console.log(JSON.stringify(row));
  }
  return EXIT_OK;
}

export async function runsExport(args: string[]): Promise<number> {
  const runId = firstPositionalArg(args, ['--output', '--file', '--format']);
  const outputDir = resolve(valueAfter(args, '--output') ?? defaultRunsDir());
  const targetFile = valueAfter(args, '--file');
  const json = hasFlag(args, '--json');

  if (!runId || !targetFile) {
    return printUsageError(
      json,
      !runId ? 'Error: missing runId' : 'Error: missing --file',
      'Usage: octoparse runs export <runId> --file <result.xlsx> [--output <dir>] [--format xlsx|csv|html|json|xml] [--json]'
    );
  }
  const format = normalizeDataExportFormat(valueAfter(args, '--format'), targetFile);
  if (!format) {
    return printUsageError(json, '--format supports xlsx, csv, html, json, and xml', undefined, 'UNSUPPORTED_EXPORT_FORMAT');
  }

  const runDir = join(outputDir, runId);
  if (!runArtifactExists(outputDir, runId)) {
    return printMissingRun(json, runId);
  }
  const rows = await readJsonLines(join(runDir, 'rows.jsonl'), Number.MAX_SAFE_INTEGER) as Record<string, unknown>[];
  const exported = await exportRowsToFile(rows, targetFile, format);

  const result = { runId, rows: exported.rows, file: exported.file, format: exported.format };
  if (json) printEnvelope(true, result);
  else console.log(`Exported ${rows.length} rows -> ${result.file}`);
  return EXIT_OK;
}
