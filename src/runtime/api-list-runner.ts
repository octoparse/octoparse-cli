import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { JSONPath } from 'jsonpath-plus';
import { appendJsonLine, ensureRunDir, writeRunSummary } from './artifacts.js';
import { exportRowsToFile } from './data-exporter.js';
import { safeFileName } from './naming.js';
import type { ApiListField, ApiListTask, RunOptions, RunSummary, TaskDefinition } from '../types.js';

type JsonPathInput = string | number | boolean | object | unknown[] | null;

export async function runApiListTask(task: TaskDefinition, options: RunOptions): Promise<RunSummary> {
  if (!task.apiList) throw new Error('task is missing apiList configuration');
  const startedAt = new Date().toISOString();
  const runId = `run_${safeFileName(task.taskId)}_${randomUUID()}`;
  const lotId = Date.now().toString();
  const runDir = await ensureRunDir(options.outputDir, runId);
  await appendJsonLine(join(runDir, 'events.jsonl'), {
    event: 'run.started',
    runId,
    lotId,
    taskId: task.taskId,
    taskName: task.taskName,
    mode: 'api_list'
  });

  let total = 0;
  let page = task.apiList.pagination?.start ?? 0;
  const step = task.apiList.pagination?.step ?? 1;
  const maxPages = task.apiList.pagination
    ? task.apiList.pagination.maxPages ?? Number.POSITIVE_INFINITY
    : 1;
  let fetchedPages = 0;
  let stopReason: string | undefined;
  const rows: Record<string, unknown>[] = [];

  while (total < (options.maxRows ?? Number.POSITIVE_INFINITY) && fetchedPages < maxPages) {
    const pageResult = await fetchApiListPage(task.apiList, page);
    await appendJsonLine(join(runDir, 'events.jsonl'), {
      event: 'api.page',
      runId,
      taskId: task.taskId,
      page,
      count: pageResult.items.length,
      url: pageResult.url
    });

    if (!pageResult.items.length) break;
    for (const item of pageResult.items) {
      if (options.maxRows !== undefined && total >= options.maxRows) {
        stopReason = 'max_rows';
        break;
      }
      const row = extractApiListRow(item, task.apiList.fields);
      if (task.apiList.rawFieldName) row[task.apiList.rawFieldName] = item;
      total += 1;
      rows.push(row);
      await appendJsonLine(join(runDir, 'rows.jsonl'), row);
      await appendJsonLine(join(runDir, 'events.jsonl'), { event: 'row', runId, taskId: task.taskId, total, data: row });
      if (options.jsonl) console.log(JSON.stringify({ event: 'row', runId, taskId: task.taskId, total, data: row }));
    }
    if (stopReason) break;
    fetchedPages += 1;
    page += step;
  }

  const summary: RunSummary = {
    runId,
    lotId,
    taskId: task.taskId,
    taskName: task.taskName,
    status: 'completed',
    total,
    outputDir: runDir,
    startedAt,
    stoppedAt: new Date().toISOString(),
    ...(stopReason ? { stopReason } : {}),
    ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {})
  };
  await exportRowsToFile(rows, join(runDir, 'rows.json'), 'json');
  await exportRowsToFile(rows, join(runDir, 'rows.csv'), 'csv');
  await writeRunSummary(runDir, summary);
  await appendJsonLine(join(runDir, 'events.jsonl'), { event: 'run.stopped', ...summary });
  if (options.jsonl) console.log(JSON.stringify({ event: 'run.stopped', ...summary }));
  return summary;
}

async function fetchApiListPage(apiList: ApiListTask, page: number): Promise<{ url: string; items: unknown[] }> {
  const request = apiList.request;
  const url = new URL(request.url);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(key, String(value));
  }
  if (apiList.pagination?.type === 'page') {
    url.searchParams.set(apiList.pagination.param, String(page));
    if (apiList.pagination.pageSizeParam && apiList.pagination.pageSize !== undefined) {
      url.searchParams.set(apiList.pagination.pageSizeParam, String(apiList.pagination.pageSize));
    }
  }

  const method = request.method ?? 'GET';
  const body = method === 'POST' && request.body !== undefined ? JSON.stringify(request.body) : undefined;
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      'User-Agent': 'Mozilla/5.0',
      ...(request.headers ?? {})
    },
    ...(body !== undefined ? { body } : {})
  });
  if (!response.ok) throw new Error(`API list request failed: HTTP ${response.status} ${response.statusText} (${url})`);
  const payload = await response.json() as unknown;
  const items = JSONPath({ path: apiList.itemsPath, json: toJsonPathInput(payload), wrap: false }) as unknown;
  return { url: url.toString(), items: Array.isArray(items) ? items : [] };
}

function extractApiListRow(item: unknown, fields: ApiListField[]): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = JSONPath({ path: field.path, json: toJsonPathInput(item), wrap: false }) as unknown;
    row[field.name] = normalizeFieldValue(raw, field);
  }
  return row;
}

function normalizeFieldValue(value: unknown, field: ApiListField): unknown {
  if (value === undefined || value === null) return '';
  if (field.valuePrefix && typeof value === 'string' && value && !/^https?:\/\//i.test(value) && !value.startsWith('//')) {
    value = `${field.valuePrefix}${value}`;
  }
  if (field.type === 'array') return Array.isArray(value) ? value : [value];
  if (field.type === 'number') return typeof value === 'number' ? value : Number(value);
  if (field.type === 'boolean') return Boolean(value);
  if (field.type === 'url' && typeof value === 'string') return normalizeUrl(value);
  return value;
}

function normalizeUrl(value: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('//')) return `https:${value}`;
  return value;
}

function toJsonPathInput(value: unknown): JsonPathInput {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return value;
  return null;
}
