import { join, resolve } from 'node:path';
import { firstPositionalArg, hasFlag, parsePositiveInt, valueAfter } from '../cli/args.js';
import { printEnvelope, printUsageError } from '../cli/output.js';
import { cloudHistory } from './cloud.js';
import { printAuthRequired } from './auth.js';
import { ApiRequestError, fetchTaskInfo } from '../runtime/api-client.js';
import { resolveAuth } from '../runtime/auth.js';
import { fetchCloudRows } from '../runtime/cloud-data.js';
import { exportRowsToFile, normalizeDataExportFormat } from '../runtime/data-exporter.js';
import { listRuns } from '../runtime/artifacts.js';
import { countRunRows, defaultRunsDir, listActiveRuns, readJsonLines } from '../runtime/local-runs.js';
import { defaultExportFileName } from '../runtime/naming.js';
import { EXIT_OK, EXIT_OPERATION_FAILED, type RunSummary } from '../types.js';

export async function localHistory(args: string[]): Promise<number> {
  const taskId = firstPositionalArg(args, ['--output']);
  const json = hasFlag(args, '--json');
  const outputDir = resolve(valueAfter(args, '--output') ?? defaultRunsDir());
  if (!taskId) {
    return printUsageError(json, 'Error: missing taskId', 'Usage: octoparse local history <taskId> [--output <dir>] [--json]');
  }

  const lots = await listLocalLots(outputDir, taskId);
  if (json) {
    printEnvelope(true, lots.map(localLotToPublic));
    return EXIT_OK;
  }

  if (!lots.length) {
    console.log(`No local extraction lots found: ${taskId}`);
    return EXIT_OK;
  }

  console.log(`Local extraction lots: ${taskId}\n`);
  for (const lot of lots) {
    console.log(`  ${lot.lotId}  ${lot.status}  rows=${lot.total}  ${lot.startedAt}`);
  }
  return EXIT_OK;
}

export async function localExport(args: string[]): Promise<number> {
  const taskId = firstPositionalArg(args, ['--file', '--lot-id', '--lot', '--output', '--format']);
  const json = hasFlag(args, '--json');
  const outputDir = resolve(valueAfter(args, '--output') ?? defaultRunsDir());
  const lotId = valueAfter(args, '--lot-id') ?? valueAfter(args, '--lot');
  const targetFile = valueAfter(args, '--file');

  if (!taskId) {
    return printUsageError(
      json,
      'Error: missing taskId',
      'Usage: octoparse local export <taskId> [--file <result.xlsx>] [--lot-id <lotId>] [--output <dir>] [--format xlsx|csv|html|json|xml] [--json]'
    );
  }

  const format = normalizeDataExportFormat(valueAfter(args, '--format'), targetFile);
  if (!format) {
    return printUsageError(json, '--format supports xlsx, csv, html, json, and xml', undefined, 'UNSUPPORTED_EXPORT_FORMAT');
  }

  const lot = await findLocalLot(outputDir, taskId, lotId);
  if (!lot) {
    const message = lotId
      ? `Local extraction lot not found: taskId=${taskId}, lotId=${lotId}`
      : `No local extraction history found for task ${taskId}`;
    if (json) printEnvelope(false, undefined, 'LOCAL_LOT_NOT_FOUND', message);
    else console.error(message);
    return EXIT_OPERATION_FAILED;
  }

  const runDir = join(outputDir, lot.runId);
  const rows = await readJsonLines(join(runDir, 'rows.jsonl'), Number.MAX_SAFE_INTEGER) as Record<string, unknown>[];
  const taskName = lot.taskName ?? await resolveTaskName(taskId);
  const exportFile = targetFile ?? defaultExportFileName(taskName, format);
  const exported = await exportRowsToFile(rows, exportFile, format);
  const result = {
    taskId,
    taskName,
    lotId: lot.lotId,
    rows: exported.rows,
    file: exported.file,
    format: exported.format
  };

  if (json) {
    printEnvelope(true, result);
  } else {
    console.log(`Exported ${result.rows} rows -> ${result.file}`);
    console.log(`Task: ${result.taskId}`);
    console.log(`Lot: ${result.lotId}`);
    console.log(`Format: ${result.format}`);
  }
  return EXIT_OK;
}

export async function dataHistory(args: string[]): Promise<number> {
  const source = parseDataSource(args);
  return source === 'cloud' ? cloudHistory(args) : localHistory(args);
}

export async function dataExport(args: string[]): Promise<number> {
  const source = parseDataSource(args);
  return source === 'cloud' ? cloudDataExport(args) : localExport(args);
}

async function cloudDataExport(args: string[]): Promise<number> {
  const taskId = firstPositionalArg(args, ['--source', '--file', '--lot-id', '--lot', '--format', '--api-base-url', '--batch-size']);
  const json = hasFlag(args, '--json');
  const lotId = valueAfter(args, '--lot-id') ?? valueAfter(args, '--lot');
  const targetFile = valueAfter(args, '--file');

  if (!taskId) {
    return printUsageError(
      json,
      'Error: missing taskId',
      'Usage: octoparse data export <taskId> --source cloud [--file <result.xlsx>] [--lot-id <lotId>] [--format xlsx|csv|html|json|xml] [--json]'
    );
  }

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.apiKey) {
    return printAuthRequired(json);
  }

  const format = normalizeDataExportFormat(valueAfter(args, '--format'), targetFile);
  if (!format) {
    return printUsageError(json, '--format supports xlsx, csv, html, json, and xml', undefined, 'UNSUPPORTED_EXPORT_FORMAT');
  }

  try {
    const rows = await fetchCloudRows({
      apiKey: auth.apiKey,
      taskId,
      lotId,
      baseUrl: valueAfter(args, '--api-base-url'),
      batchSize: parsePositiveInt(valueAfter(args, '--batch-size'), 100)
    });
    const taskName = await resolveTaskName(taskId);
    const exportFile = targetFile ?? defaultExportFileName(taskName, format);
    const exported = await exportRowsToFile(rows, exportFile, format);
    const result = {
      taskId,
      taskName,
      source: 'cloud',
      lotId,
      rows: exported.rows,
      file: exported.file,
      format: exported.format
    };

    if (json) {
      printEnvelope(true, result);
    } else {
      console.log(`Exported ${result.rows} cloud rows -> ${result.file}`);
      console.log(`Task: ${result.taskId}`);
      if (result.lotId) console.log(`Lot: ${result.lotId}`);
      console.log(`Format: ${result.format}`);
    }
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, 'Failed to export cloud data', error);
  }
}

function parseDataSource(args: string[]): 'local' | 'cloud' {
  if (hasFlag(args, '--cloud')) return 'cloud';
  if (hasFlag(args, '--local')) return 'local';
  const source = valueAfter(args, '--source');
  return source === 'cloud' ? 'cloud' : 'local';
}

async function listLocalLots(outputDir: string, taskId: string): Promise<RunSummary[]> {
  const runs = await listRuns(outputDir);
  const activeRuns = await listActiveRuns(outputDir);
  const byRunId = new Map<string, RunSummary>();
  for (const run of runs) byRunId.set(run.runId, withLotId(run));
  for (const run of activeRuns) byRunId.set(run.runId, withLotId(run));
  const matched = [...byRunId.values()]
    .filter((run) => run.taskId === taskId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return Promise.all(matched.map((run) => withActualRowCount(outputDir, run)));
}

async function findLocalLot(outputDir: string, taskId: string, lotId?: string): Promise<RunSummary | null> {
  const lots = await listLocalLots(outputDir, taskId);
  if (!lots.length) return null;
  if (!lotId) return lots[0];
  return lots.find((lot) => lot.lotId === lotId) ?? null;
}

function withLotId(summary: RunSummary): RunSummary {
  return summary.lotId ? summary : { ...summary, lotId: deriveLotId(summary.runId) };
}

async function withActualRowCount(outputDir: string, summary: RunSummary): Promise<RunSummary> {
  const total = await countRunRows(outputDir, summary.runId);
  return total === summary.total ? summary : { ...summary, total };
}

function localLotToPublic(summary: RunSummary) {
  return {
    taskId: summary.taskId,
    taskName: summary.taskName,
    lotId: summary.lotId,
    status: summary.status,
    total: summary.total,
    startedAt: summary.startedAt,
    stoppedAt: summary.stoppedAt
  };
}

function deriveLotId(runId: string): string {
  const stamp = runId.match(/_(\d{14})$/)?.[1];
  return stamp ? `lot_${stamp}` : runId;
}

async function resolveTaskName(taskId: string): Promise<string> {
  const auth = await resolveAuth();
  if (!auth.apiKey) return taskId;
  try {
    const info = await fetchTaskInfo({ apiKey: auth.apiKey, taskId });
    return String(info.taskName ?? info.TaskName ?? taskId).trim() || taskId;
  } catch {
    return taskId;
  }
}

function printApiError(json: boolean, prefix: string, error: unknown): number {
  const code = error instanceof ApiRequestError ? error.code : 'API_REQUEST_FAILED';
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    printEnvelope(false, undefined, code, message);
  } else {
    console.error(`${code === 'AUTH_INVALID' ? 'Authentication failed' : prefix}: ${message}`);
    if (error instanceof ApiRequestError && error.body && code !== 'AUTH_INVALID') {
      console.error(`Response: ${error.body}`);
    }
  }
  return EXIT_OPERATION_FAILED;
}
