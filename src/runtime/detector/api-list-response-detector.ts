import type { HTTPResponse } from 'puppeteer-core';
import type { DetectedApiListCandidate } from './types.js';

const MAX_CAPTURED_RESPONSES = 40;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_JSON_DEPTH = 6;

interface CapturedJsonResponse {
  url: string;
  method: 'GET' | 'POST';
  status: number;
  contentType: string;
  requestBody?: unknown;
  payload: unknown;
}

export interface ApiResponseCapture {
  stop(): void;
  candidates(): DetectedApiListCandidate[];
}

export function startApiResponseCapture(page: { on: Function; off?: Function; removeListener?: Function }): ApiResponseCapture {
  const captured: CapturedJsonResponse[] = [];
  const seen = new Set<string>();
  const handler = (response: HTTPResponse) => {
    void captureResponse(response, captured, seen).catch(() => undefined);
  };
  page.on('response', handler);
  return {
    stop() {
      if (typeof page.off === 'function') page.off('response', handler);
      else if (typeof page.removeListener === 'function') page.removeListener('response', handler);
    },
    candidates() {
      return detectApiListCandidates(captured);
    }
  };
}

export function detectApiListCandidatesForTesting(responses: Array<{
  url: string;
  method?: 'GET' | 'POST';
  requestBody?: unknown;
  status?: number;
  contentType?: string;
  payload: unknown;
}>): DetectedApiListCandidate[] {
  return detectApiListCandidates(responses.map((item) => ({
    url: item.url,
    method: item.method ?? 'GET',
    status: item.status ?? 200,
    contentType: item.contentType ?? 'application/json',
    ...(item.requestBody !== undefined ? { requestBody: item.requestBody } : {}),
    payload: item.payload
  })));
}

export async function detectApiListCandidatesFromResourceTimings(page: {
  evaluate: Function;
}): Promise<DetectedApiListCandidate[]> {
  const urls = await page.evaluate(() => {
    return performance.getEntriesByType('resource')
      .map((entry) => ({
        name: entry.name,
        initiatorType: (entry as PerformanceResourceTiming).initiatorType
      }))
      .filter((entry) => entry.initiatorType === 'fetch' || entry.initiatorType === 'xmlhttprequest')
      .map((entry) => entry.name)
      .filter((value, index, array) => value && array.indexOf(value) === index)
      .slice(0, 80);
  }) as string[];
  const responses: CapturedJsonResponse[] = [];
  for (const url of urls.filter(isLikelyListApiUrl).slice(0, 12)) {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0'
      }
    }).catch(() => undefined);
    if (!response?.ok) continue;
    const contentType = response.headers.get('content-type') || '';
    if (!/json/i.test(contentType)) continue;
    const text = await response.text().catch(() => '');
    if (!text || text.length > MAX_RESPONSE_BYTES) continue;
    try {
      responses.push({
        url,
        method: 'GET',
        status: response.status,
        contentType,
        payload: JSON.parse(text) as unknown
      });
    } catch {
      // ignore invalid JSON resources
    }
  }
  return detectApiListCandidates(responses);
}

async function captureResponse(
  response: HTTPResponse,
  captured: CapturedJsonResponse[],
  seen: Set<string>
): Promise<void> {
  if (captured.length >= MAX_CAPTURED_RESPONSES) return;
  const request = response.request();
  const resourceType = request.resourceType();
  if (resourceType !== 'xhr' && resourceType !== 'fetch') return;
  const method = request.method().toUpperCase();
  if (method !== 'GET' && method !== 'POST') return;
  const requestBody = method === 'POST' ? parseJsonPostBody(request.postData()) : undefined;
  if (method === 'POST' && requestBody === undefined) return;
  const status = response.status();
  if (status < 200 || status >= 300) return;
  const headers = response.headers();
  const contentType = headers['content-type'] || headers['Content-Type'] || '';
  if (!/json/i.test(contentType)) return;
  const key = `${method}:${response.url()}`;
  if (seen.has(key)) return;
  seen.add(key);
  const text = await response.text();
  if (!text || text.length > MAX_RESPONSE_BYTES) return;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return;
  }
  captured.push({ url: response.url(), method, status, contentType, ...(requestBody !== undefined ? { requestBody } : {}), payload });
}

function detectApiListCandidates(responses: CapturedJsonResponse[]): DetectedApiListCandidate[] {
  const candidates: DetectedApiListCandidate[] = [];
  for (const response of responses) {
    for (const arrayCandidate of findObjectArrays(response.payload)) {
      const analysis = analyzeItems(arrayCandidate.items);
      if (!analysis) continue;
      const pagination = inferPagePagination(response.url, response.payload);
      const confidence = Math.min(0.98, analysis.score + (pagination ? 0.12 : 0));
      if (confidence < 0.58) continue;
      const id = `api_list_${candidates.length + 1}`;
      candidates.push({
        id,
        type: 'api_list',
        title: `API list (${arrayCandidate.items.length} items)`,
        confidence,
        request: requestFromUrl(response.url, response.method, response.requestBody),
        ...(pagination ? { pagination } : {}),
        itemsPath: arrayCandidate.path,
        fields: analysis.fields,
        sampleRows: arrayCandidate.items.slice(0, 3).map((item) => sampleRow(item, analysis.fields)),
        itemCount: arrayCandidate.items.length,
        reasons: [
          `JSON response contains object array at ${arrayCandidate.path}`,
          ...analysis.reasons,
          ...(pagination ? [`page pagination inferred from query param "${pagination.param}"`] : [])
        ]
      });
    }
  }
  return dedupeApiCandidates(candidates)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 6);
}

function isLikelyListApiUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const combined = `${url.hostname} ${url.pathname} ${url.searchParams.toString()}`;
  if (!/(api|search|product|products|list|items|catalog|graphql|bff|ajax)/i.test(combined)) return false;
  return ['page', 'pageIndex', 'pageNo', 'currentPage', 'p', 'pageSize', 'limit', 'size', 'offset'].some((param) => url.searchParams.has(param))
    || /(search|product|products|list|items|catalog)/i.test(url.pathname);
}

function requestFromUrl(value: string, method: 'GET' | 'POST', body?: unknown): DetectedApiListCandidate['request'] {
  const url = new URL(value);
  const query: Record<string, string> = {};
  for (const [key, item] of url.searchParams.entries()) query[key] = item;
  url.search = '';
  return {
    url: url.toString(),
    method,
    ...(Object.keys(query).length ? { query } : {}),
    ...(body !== undefined ? { body } : {})
  };
}

function findObjectArrays(payload: unknown): Array<{ path: string; items: Record<string, unknown>[] }> {
  const result: Array<{ path: string; items: Record<string, unknown>[] }> = [];
  const visit = (value: unknown, path: string, depth: number) => {
    if (depth > MAX_JSON_DEPTH) return;
    if (Array.isArray(value)) {
      const items = value.filter(isRecord);
      if (items.length >= 3 && items.length >= Math.ceil(value.length * 0.75)) {
        result.push({ path, items });
      }
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) visit(child, joinJsonPath(path, key), depth + 1);
  };
  visit(payload, '$', 0);
  return result;
}

function analyzeItems(items: Record<string, unknown>[]): {
  score: number;
  fields: DetectedApiListCandidate['fields'];
  reasons: string[];
} | null {
  const flattened = items.slice(0, 8).map((item) => flattenRecord(item));
  const allPaths = [...new Set(flattened.flatMap((item) => Object.keys(item)))];
  const fieldScores = allPaths
    .map((path) => scoreField(path, flattened.map((item) => item[path]).filter((value) => value !== undefined)))
    .filter((field): field is NonNullable<typeof field> => Boolean(field))
    .sort((a, b) => b.score - a.score);
  const fields = fieldScores.slice(0, 18).map((field) => ({
    name: field.name,
    path: jsonPathFromFlatPath(field.path),
    type: field.type,
    ...(field.valuePrefix ? { valuePrefix: field.valuePrefix } : {}),
    samples: field.samples
  }));
  const semanticScore = fieldScores.slice(0, 10).reduce((sum, field) => sum + field.score, 0);
  const score = Math.min(0.86, 0.25 + items.length / 100 + semanticScore / 12);
  const hasName = fields.some((field) => /name|title|product|商品|标题/i.test(field.name));
  const hasUrlOrImage = fields.some((field) => field.type === 'url' || /url|image|link|href/i.test(field.name));
  const hasPriceOrMeta = fields.some((field) => /price|amount|rating|count|date|价格|评分/i.test(field.name));
  if (fields.length < 3 || (!hasName && !hasUrlOrImage) || (!hasPriceOrMeta && fields.length < 6)) return null;
  return {
    score,
    fields,
    reasons: [
      `${items.length} records in response sample`,
      `${fields.length} extractable fields inferred`
    ]
  };
}

function scoreField(path: string, values: unknown[]): {
  path: string;
  name: string;
  type: 'string' | 'number' | 'boolean' | 'url' | 'array';
  valuePrefix?: string;
  samples: string[];
  score: number;
} | null {
  if (!values.length) return null;
  const leaf = path.split('.').at(-1) || path;
  const samples = values.map(sampleText).filter(Boolean).slice(0, 3);
  if (!samples.length) return null;
  const lower = leaf.toLowerCase();
  let score = 0.15;
  let type: 'string' | 'number' | 'boolean' | 'url' | 'array' = 'string';
  let name = normalizeFieldName(leaf);
  if (/title|name|productname|product_name|商品|标题/i.test(leaf)) {
    score += 1.4;
    name = /brand/i.test(path) ? 'brand' : 'name';
  }
  if (/brand/i.test(leaf)) {
    score += 0.9;
    name = 'brand';
  }
  if (/price|amount|mrp|selling/i.test(path)) {
    score += 1.0;
    type = numericValues(values) ? 'number' : 'string';
    name = normalizePriceName(path);
  } else if (numericValues(values)) {
    type = 'number';
    if (/rating|count|review|stock|discount/i.test(lower)) score += 0.45;
  }
  if (/url|link|href/i.test(lower) || samples.some((value) => /^https?:\/\//i.test(value) || value.startsWith('//') || value.startsWith('/'))) {
    score += 0.95;
    type = 'url';
    name = /image|img|thumbnail|photo/i.test(lower) ? 'image_url' : 'url';
  }
  if (/image|img|thumbnail|photo/i.test(lower)) {
    score += 0.65;
    type = 'url';
    name = 'image_url';
  }
  if (values.every((value) => typeof value === 'boolean')) type = 'boolean';
  if (values.some(Array.isArray)) type = 'array';
  if (/id$/i.test(leaf) || /^id$/i.test(leaf)) {
    score += 0.3;
    name = lower.includes('product') ? 'product_id' : normalizeFieldName(leaf);
  }
  if (samples.every((value) => value.length > 500)) score -= 0.5;
  if (score < 0.35) return null;
  return { path, name, type, samples, score };
}

function inferPagePagination(urlValue: string, payload: unknown): DetectedApiListCandidate['pagination'] | undefined {
  const url = new URL(urlValue);
  const pageParam = ['page', 'pageIndex', 'pageNo', 'currentPage', 'p'].find((param) => url.searchParams.has(param));
  if (!pageParam) return undefined;
  const pageSizeParam = ['pageSize', 'limit', 'size', 'perPage', 'rows'].find((param) => url.searchParams.has(param));
  const start = Number(url.searchParams.get(pageParam));
  const queryPageSize = pageSizeParam ? Number(url.searchParams.get(pageSizeParam)) : undefined;
  const hasQueryPageSize = queryPageSize !== undefined && Number.isFinite(queryPageSize) && queryPageSize > 0;
  return {
    type: 'page',
    param: pageParam,
    start: Number.isFinite(start) ? start : 0,
    step: 1,
    ...(pageSizeParam ? { pageSizeParam } : {}),
    ...(hasQueryPageSize ? { pageSize: queryPageSize } : {}),
    ...paginationFromPayload(payload)
  };
}

function paginationFromPayload(payload: unknown): Partial<NonNullable<DetectedApiListCandidate['pagination']>> {
  if (!isRecord(payload)) return {};
  const pagination = Object.entries(payload).find(([key, value]) => /pagination|page/i.test(key) && isRecord(value))?.[1];
  if (!isRecord(pagination)) return {};
  const pageSize = numberValue(pagination.pageSize ?? pagination.size ?? pagination.limit);
  if (pageSize === undefined || !Number.isFinite(pageSize) || pageSize <= 0) return {};
  return { pageSize };
}

function sampleRow(item: Record<string, unknown>, fields: DetectedApiListCandidate['fields']): Record<string, unknown> {
  const flat = flattenRecord(item);
  const row: Record<string, unknown> = {};
  for (const field of fields) {
    const path = stripJsonPathRoot(field.path);
    row[field.name] = flat[path] ?? '';
  }
  return row;
}

function flattenRecord(value: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const path = joinFlatJsonPath(prefix, key);
    if (isRecord(item)) Object.assign(result, flattenRecord(item, path));
    else result[path] = item;
  }
  return result;
}

function dedupeApiCandidates(candidates: DetectedApiListCandidate[]): DetectedApiListCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.request.method}:${candidate.request.url}:${candidate.itemsPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeFieldName(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[^\w]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'field';
}

function normalizePriceName(path: string): string {
  const lower = path.toLowerCase();
  if (/mrp|list|original/.test(lower)) return 'mrp';
  if (/selling|sale|final|current/.test(lower)) return 'selling_price';
  return 'price';
}

function sampleText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(sampleText).filter(Boolean).slice(0, 3).join('|');
  return '';
}

function numericValues(values: unknown[]): boolean {
  return values.length > 0 && values.every((value) => typeof value === 'number' || (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))));
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) return Number(value);
  return undefined;
}

function parseJsonPostBody(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function joinJsonPath(parent: string, key: string): string {
  const child = jsonPathKey(key);
  return child.startsWith('[') ? `${parent}${child}` : `${parent}.${child}`;
}

function joinFlatJsonPath(parent: string, key: string): string {
  const child = jsonPathKey(key);
  if (!parent) return child;
  return child.startsWith('[') ? `${parent}${child}` : `${parent}.${child}`;
}

function jsonPathFromFlatPath(path: string): string {
  return path.startsWith('[') ? `$${path}` : `$.${path}`;
}

function stripJsonPathRoot(path: string): string {
  if (path === '$') return '';
  return path.startsWith('$.') ? path.slice(2) : path.replace(/^\$/, '');
}

function jsonPathKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : `['${key.replace(/'/g, "\\'")}']`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
