import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { exportRowsToFile, normalizeDataExportFormat } from '../dist/runtime/data-exporter.js';

test('normalizeDataExportFormat uses explicit format, file extension, and xlsx default', () => {
  assert.equal(normalizeDataExportFormat('csv'), 'csv');
  assert.equal(normalizeDataExportFormat('excel'), 'xlsx');
  assert.equal(normalizeDataExportFormat(undefined, 'result.json'), 'json');
  assert.equal(normalizeDataExportFormat(undefined, 'result.HTML'), 'html');
  assert.equal(normalizeDataExportFormat(undefined), 'xlsx');
  assert.equal(normalizeDataExportFormat('bad'), null);
});

test('exportRowsToFile writes CSV and avoids overwriting existing files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'octo-export-'));
  const file = join(dir, 'result.csv');
  await writeFile(file, 'existing\n');

  const result = await exportRowsToFile([
    { title: 'A', count: 1 },
    { title: 'B, quoted', count: 2 }
  ], file, 'csv');

  assert.equal(result.rows, 2);
  assert.equal(result.format, 'csv');
  assert.match(result.file, /result \(1\)\.csv$/);
  assert.equal(await readFile(file, 'utf8'), 'existing\n');
  assert.equal(await readFile(result.file, 'utf8'), 'title,count\nA,1\n"B, quoted",2\n');
});

test('exportRowsToFile writes minimal xlsx zip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'octo-xlsx-'));
  const file = join(dir, 'result.xlsx');
  const result = await exportRowsToFile([{ title: 'A' }], file, 'xlsx');

  assert.equal(result.file, file);
  assert.equal(result.rows, 1);
  assert.equal(existsSync(file), true);
  const content = await readFile(file);
  assert.equal(content.subarray(0, 4).toString('hex'), '504b0304');
});
