import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { DataExportFormat } from '../types.js';

const INTERNAL_EXPORT_FIELDS = new Set(['#', '#text', '$id', '$isSaved']);

export interface DataExportResult {
  file: string;
  format: DataExportFormat;
  rows: number;
}

export async function exportRowsToFile(
  rows: Record<string, unknown>[],
  targetFile: string,
  format: DataExportFormat
): Promise<DataExportResult> {
  const file = resolveAvailableFile(targetFile);
  await mkdir(dirname(file), { recursive: true });
  const exportRows = rows.map(toPublicExportRow);
  const content = formatRows(exportRows, format);
  await writeFile(file, content);
  return { file, format, rows: rows.length };
}

export function normalizeDataExportFormat(format: string | undefined, targetFile?: string): DataExportFormat | null {
  const value = (format ?? (targetFile ? formatFromFile(targetFile) : undefined) ?? 'xlsx').toLowerCase();
  if (value === 'excel') return 'xlsx';
  if (value === 'xlsx' || value === 'csv' || value === 'html' || value === 'json' || value === 'xml') return value;
  return null;
}

function formatFromFile(targetFile: string): DataExportFormat | undefined {
  const lower = targetFile.toLowerCase();
  if (lower.endsWith('.xlsx')) return 'xlsx';
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.xml')) return 'xml';
  return undefined;
}

function resolveAvailableFile(targetFile: string): string {
  const file = resolve(targetFile);
  if (!existsSync(file)) return file;

  const dir = dirname(file);
  const ext = extname(file);
  const name = basename(file, ext);
  for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const candidate = join(dir, `${name} (${index})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return file;
}

function formatRows(rows: Record<string, unknown>[], format: DataExportFormat): string | Buffer {
  if (format === 'xlsx') return toXlsx(rows);
  if (format === 'csv') return toCsv(rows);
  if (format === 'html') return toHtml(rows);
  if (format === 'json') return `${JSON.stringify(rows, null, 2)}\n`;
  return toXml(rows);
}

function headersOf(rows: Record<string, unknown>[]): string[] {
  return [...new Set(rows.flatMap((row) => Object.keys(row).filter((key) => !isInternalExportField(key))))];
}

function isInternalExportField(key: string): boolean {
  return INTERNAL_EXPORT_FIELDS.has(key);
}

function toPublicExportRow(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!isInternalExportField(key)) result[key] = value;
  }
  return result;
}

function toCsv(rows: Record<string, unknown>[]): string {
  const headers = headersOf(rows);
  if (!headers.length) return '';
  const lines = [
    headers.map(csvCell).join(','),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(','))
  ];
  return `${lines.join('\n')}\n`;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = primitiveText(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toHtml(rows: Record<string, unknown>[]): string {
  const headers = headersOf(rows);
  const head = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('');
  const body = rows.map((row) => {
    const cells = headers.map((header) => `<td>${escapeHtml(primitiveText(row[header]))}</td>`).join('');
    return `<tr>${cells}</tr>`;
  }).join('\n');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Octopus Export</title>
</head>
<body>
  <table>
    <thead><tr>${head}</tr></thead>
    <tbody>
${body}
    </tbody>
  </table>
</body>
</html>
`;
}

function toXml(rows: Record<string, unknown>[]): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<rows>'];
  for (const row of rows) {
    lines.push('  <row>');
    for (const [key, value] of Object.entries(row)) {
      lines.push(`    <field name="${escapeXmlAttribute(key)}">${escapeXml(primitiveText(value))}</field>`);
    }
    lines.push('  </row>');
  }
  lines.push('</rows>');
  return `${lines.join('\n')}\n`;
}

function toXlsx(rows: Record<string, unknown>[]): Buffer {
  const headers = headersOf(rows);
  const sheetRows = [headers, ...rows.map((row) => headers.map((header) => row[header]))];
  const sheetData = sheetRows.map((row, rowIndex) => {
    const cells = row.map((value, colIndex) => {
      const ref = `${columnName(colIndex + 1)}${rowIndex + 1}`;
      return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(primitiveText(value))}</t></is></c>`;
    }).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');

  return createZip([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Sheet1" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${sheetData}</sheetData>
</worksheet>`]
  ]);
}

function columnName(index: number): string {
  let name = '';
  let current = index;
  while (current > 0) {
    const modulo = (current - 1) % 26;
    name = String.fromCharCode(65 + modulo) + name;
    current = Math.floor((current - modulo) / 26);
  }
  return name;
}

function primitiveText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlAttribute(value: string): string {
  return escapeXml(value).replace(/"/g, '&quot;');
}

function createZip(files: Array<[string, string | Buffer]>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of files) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuffer, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + data.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, central, end]);
}

const CRC_TABLE = new Uint32Array(256).map((_value, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return crc >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
