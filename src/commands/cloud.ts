import { firstPositionalArg, hasFlag, valueAfter } from '../cli/args.js';
import { printEnvelope, printUsageError } from '../cli/output.js';
import { printAuthRequired } from './auth.js';
import {
  ApiRequestError,
  fetchCloudDataBatch,
  fetchCloudHistory,
  fetchCloudStatus,
  startCloudTask,
  stopCloudTask,
  type ApiResult
} from '../runtime/api-client.js';
import { resolveAuth } from '../runtime/auth.js';
import { EXIT_OK, EXIT_OPERATION_FAILED } from '../types.js';

export async function cloudCommand(subcommand: string | undefined, args: string[]): Promise<number> {
  const json = hasFlag([subcommand ?? '', ...args], '--json');
  if (subcommand === 'start' || subcommand === 'stop') {
    return cloudAction(subcommand, args);
  }

  if (subcommand === 'status') {
    return cloudStatus(args);
  }

  if (subcommand === 'history') {
    return cloudHistory(args);
  }

  return printUsageError(
    json,
    'Error: invalid cloud subcommand; cloud extraction supports start/stop, not pause/resume.',
    'Usage: octoparse cloud <start|stop|status|history> <taskId> [--json]'
  );
}

async function cloudAction(command: 'start' | 'stop', args: string[]): Promise<number> {
  const taskId = firstPositionalArg(args, ['--api-base-url']);
  const json = hasFlag(args, '--json');
  if (!taskId) {
    return printUsageError(json, 'Error: missing taskId', `Usage: octoparse cloud ${command} <taskId> [--json]`);
  }

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.apiKey) {
    return printAuthRequired(json);
  }

  try {
    const result = command === 'start'
      ? await startCloudTask({ apiKey: auth.apiKey, taskId, baseUrl: valueAfter(args, '--api-base-url') })
      : await stopCloudTask({ apiKey: auth.apiKey, taskId, baseUrl: valueAfter(args, '--api-base-url') });
    if (json) {
      printEnvelope(true, { taskId, action: command, ...result });
    } else {
      console.log(`Cloud ${command}: ${taskId}`);
      printCloudApiResult(result);
    }
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, `Failed to ${command} cloud extraction`, error);
  }
}

async function cloudStatus(args: string[]): Promise<number> {
  const taskId = firstPositionalArg(args, ['--api-base-url']);
  const json = hasFlag(args, '--json');
  if (!taskId) {
    return printUsageError(json, 'Error: missing taskId', 'Usage: octoparse cloud status <taskId> [--json]');
  }

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.apiKey) {
    return printAuthRequired(json);
  }

  try {
    const result = await fetchCloudStatus({ apiKey: auth.apiKey, taskId, baseUrl: valueAfter(args, '--api-base-url') });
    if (json) {
      printEnvelope(true, { taskId, ...result });
    } else {
      printCloudLiveInfo(taskId, result.data);
    }
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, 'Failed to fetch cloud extraction status', error);
  }
}

export async function cloudHistory(args: string[]): Promise<number> {
  const taskId = firstPositionalArg(args, ['--api-base-url', '--source']);
  const json = hasFlag(args, '--json');
  if (!taskId) {
    return printUsageError(json, 'Error: missing taskId', 'Usage: octoparse cloud history <taskId> [--json]');
  }

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.apiKey) {
    return printAuthRequired(json);
  }

  try {
    const result = await fetchCloudHistory({ apiKey: auth.apiKey, taskId, baseUrl: valueAfter(args, '--api-base-url') });
    const items = await withCloudExportStats({
      apiKey: auth.apiKey,
      taskId,
      baseUrl: valueAfter(args, '--api-base-url'),
      items: result.data
    });
    if (json) {
      printEnvelope(true, { taskId, ...result, data: items });
    } else {
      if (!items.length) {
        console.log(`No cloud extraction history found: ${taskId}`);
        return EXIT_OK;
      }
      console.log(`Cloud extraction history: ${taskId}\n`);
      for (const item of items) {
        const record = asRecord(item);
        console.log(formatCloudHistoryLine(record));
      }
    }
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, 'Failed to fetch cloud extraction history', error);
  }
}

async function withCloudExportStats(options: {
  apiKey: string;
  taskId: string;
  baseUrl?: string;
  items: unknown[];
}): Promise<unknown[]> {
  return Promise.all(options.items.map(async (item) => {
    const record = asRecord(item);
    const lotId = stringValue(record.lot);
    if (!lotId) return item;
    const stats = await fetchCloudExportStats({
      apiKey: options.apiKey,
      taskId: options.taskId,
      lotId,
      baseUrl: options.baseUrl
    });
    return stats ? { ...record, ...stats } : item;
  }));
}

async function fetchCloudExportStats(options: {
  apiKey: string;
  taskId: string;
  lotId: string;
  baseUrl?: string;
}): Promise<{ uniqueRows: number; duplicateRows: number; exportRows: number } | null> {
  try {
    const result = await fetchCloudDataBatch({
      apiKey: options.apiKey,
      taskId: options.taskId,
      lotId: options.lotId,
      baseUrl: options.baseUrl,
      offset: 0,
      size: 1
    });
    const data = asRecord(result.data);
    const uniqueRows = numberValue(data.total);
    const duplicateRows = numberValue(data.duplicate);
    if (uniqueRows === null && duplicateRows === null) return null;
    const resolvedUniqueRows = uniqueRows ?? 0;
    return {
      uniqueRows: resolvedUniqueRows,
      duplicateRows: duplicateRows ?? 0,
      exportRows: resolvedUniqueRows
    };
  } catch {
    return null;
  }
}

function formatCloudHistoryLine(record: Record<string, unknown>): string {
  const rows = String(record.extCnt ?? record.dataCnt ?? 0);
  const uniqueRows = numberValue(record.uniqueRows);
  const duplicateRows = numberValue(record.duplicateRows);
  const exportStats = uniqueRows === null
    ? ''
    : `  uniqueRows=${uniqueRows}${duplicateRows && duplicateRows > 0 ? `  duplicateRows=${duplicateRows}` : ''}`;
  return `  ${String(record.lot ?? '')}  ${cloudStatusName(record.status)}  rows=${rows}${exportStats}  ${String(record.startTime ?? record.startExtractTime ?? '')}`;
}

function printCloudApiResult(result: ApiResult): void {
  console.log(`API: ${result.baseUrl}${result.endpoint}`);
  const data = asRecord(result.data);
  if (!Object.keys(data).length) {
    console.log('Result: ok');
    return;
  }
  for (const [key, value] of Object.entries(data)) {
    console.log(`${key}: ${formatValue(value)}`);
  }
}

function printCloudLiveInfo(taskId: string, data: unknown): void {
  const info = asRecord(data);
  if (!Object.keys(info).length) {
    console.log(`${taskId}  no_status`);
    return;
  }
  console.log(`${taskId}  ${cloudStatusName(info.status)}`);
  if (info.lot !== undefined) console.log(`Lot: ${String(info.lot)}`);
  if (info.extCnt !== undefined || info.dataCnt !== undefined) console.log(`Rows: ${String(info.extCnt ?? info.dataCnt)}`);
  if (info.startTime !== undefined || info.startExtractTime !== undefined) console.log(`Start: ${String(info.startTime ?? info.startExtractTime)}`);
  if (info.endTime !== undefined) console.log(`End: ${String(info.endTime)}`);
  const progress = asRecord(info.stProg);
  if (Object.keys(progress).length) {
    console.log(`Subtasks: executing=${String(progress.executingCnt ?? 0)} finished=${String(progress.finishedCnt ?? 0)} stopped=${String(progress.stoppedCnt ?? 0)} waiting=${String(progress.waittingCnt ?? 0)}`);
  }
}

function cloudStatusName(status: unknown): string {
  const value = Number(status);
  if (value === -1) return 'initializing';
  if (value === 0 || value === 1) return 'waiting';
  if (value === 2 || value === 3) return 'running';
  if (value === 4) return 'stopped';
  if (value === 5) return 'completed';
  return status === undefined || status === null ? 'unknown' : String(status);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value).trim();
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value);
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
