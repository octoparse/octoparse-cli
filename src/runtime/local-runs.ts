import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RunSummary } from '../types.js';
import { controlStateToSummary, isRunControlReachable, readRunControlState } from './run-control.js';

export function defaultRunsDir(): string {
  return join(homedir(), '.octoparse', 'runs');
}

export function runMetaExists(outputDir: string, runId: string): boolean {
  return existsSync(join(outputDir, runId, 'meta.json'));
}

export async function readRunSummary(outputDir: string, runId: string): Promise<RunSummary | null> {
  try {
    const raw = await readFile(join(outputDir, runId, 'meta.json'), 'utf8');
    return JSON.parse(raw) as RunSummary;
  } catch {
    return null;
  }
}

export async function readActiveRunSummary(outputDir: string, runId: string): Promise<RunSummary | null> {
  const state = await readRunControlState(outputDir, runId);
  return state ? controlStateToSummary(state) : null;
}

export async function listActiveRuns(outputDir: string): Promise<RunSummary[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(outputDir);
  } catch {
    return [];
  }

  const runs: RunSummary[] = [];
  for (const entry of entries) {
    const state = await readRunControlState(outputDir, entry);
    if (!state) continue;
    if (await isRunControlReachable(state)) {
      runs.push(controlStateToSummary(state));
      continue;
    }
    const total = await countRunRows(outputDir, state.runId);
    if (total > 0) {
      runs.push({ ...controlStateToSummary(state), status: 'stopped', total, stoppedAt: state.updatedAt });
    }
  }
  return runs;
}

export async function countRunRows(outputDir: string, runId: string): Promise<number> {
  return countJsonLines(join(outputDir, runId, 'rows.jsonl'));
}

export async function readJsonLines(filePath: string, limit: number): Promise<unknown[]> {
  let raw = '';
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const rows: unknown[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
      if (rows.length >= limit) break;
    } catch {
      rows.push({ raw: line });
    }
  }
  return rows;
}

async function countJsonLines(filePath: string): Promise<number> {
  let raw = '';
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return 0;
  }
  return raw.split('\n').filter((line) => line.trim()).length;
}
