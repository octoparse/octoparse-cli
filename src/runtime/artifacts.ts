import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunSummary } from '../types.js';

export async function ensureRunDir(baseDir: string, runId: string): Promise<string> {
  const runDir = join(baseDir, runId);
  await mkdir(runDir, { recursive: true });
  return runDir;
}

export async function writeRunSummary(runDir: string, summary: RunSummary): Promise<void> {
  await writeFile(join(runDir, 'meta.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}

export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

export async function listRuns(baseDir: string): Promise<RunSummary[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(baseDir);
  } catch {
    return [];
  }

  const runs: RunSummary[] = [];
  for (const entry of entries) {
    try {
      const raw = await readFile(join(baseDir, entry, 'meta.json'), 'utf8');
      runs.push(JSON.parse(raw) as RunSummary);
    } catch {
      // Ignore incomplete run directories.
    }
  }

  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
