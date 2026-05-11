import { inflateRawSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import { fetchCloudDataBatch } from './api-client.js';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false
});

export interface CloudDataExportOptions {
  apiKey: string;
  taskId: string;
  lotId?: string;
  baseUrl?: string;
  batchSize?: number;
}

export async function fetchCloudRows(options: CloudDataExportOptions): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  const size = options.batchSize ?? 100;
  let offset = 0;

  while (true) {
    const result = await fetchCloudDataBatch({
      apiKey: options.apiKey,
      taskId: options.taskId,
      lotId: options.lotId,
      baseUrl: options.baseUrl,
      offset,
      size
    });
    const data = toRecord(result.data);
    const files = Array.isArray(data.files) ? data.files : [];
    for (const file of files) {
      const row = decodeCloudDataFile(file);
      if (row) rows.push(row);
    }

    const nextOffset = toNumber(data.offset);
    const restTotal = toNumber(data.restTotal);
    if (!files.length || restTotal <= 0 || nextOffset <= offset) break;
    offset = nextOffset;
  }

  return rows;
}

function decodeCloudDataFile(file: unknown): Record<string, unknown> | null {
  const record = toRecord(file);
  const fileBody = typeof record.fileBody === 'string' ? record.fileBody : '';
  if (!fileBody) return null;

  const xml = unzipFirstTextFile(Buffer.from(fileBody, 'base64'));
  const parsed = xmlParser.parse(xml) as unknown;
  const root = toRecord(parsed).Root ?? toRecord(parsed).root ?? parsed;
  return toRecord(root);
}

function unzipFirstTextFile(zip: Buffer): string {
  let offset = 0;
  while (offset + 30 <= zip.length) {
    if (zip.readUInt32LE(offset) !== 0x04034b50) break;
    const method = zip.readUInt16LE(offset + 8);
    const compressedSize = zip.readUInt32LE(offset + 18);
    const fileNameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > zip.length) break;

    const compressed = zip.subarray(dataStart, dataEnd);
    const content = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
    if (content) return content.toString('utf8');
    offset = dataEnd;
  }
  throw new Error('Cloud data file is not a recognized zip/XML format');
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.parseInt(String(value ?? 0), 10) || 0;
}
