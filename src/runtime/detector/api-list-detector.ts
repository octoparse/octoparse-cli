import type { ApiListTask, TaskDefinition } from '../../types.js';
import type { DetectedApiListCandidate } from './types.js';

export function buildKnownApiListTask(options: {
  url: string;
  taskId: string;
  taskName: string;
}): TaskDefinition | null {
  const parsed = safeUrl(options.url);
  if (!parsed) return null;
  if (isTataCliqSearchUrl(parsed)) {
    return buildTataCliqSearchTask(options);
  }
  return null;
}

export function detectKnownApiListCandidates(url: string): DetectedApiListCandidate[] {
  const parsed = safeUrl(url);
  if (!parsed) return [];
  if (isTataCliqSearchUrl(parsed)) return [buildTataCliqSearchCandidate(url)];
  return [];
}

export function buildTaskFromApiListCandidate(options: {
  url: string;
  taskId: string;
  taskName: string;
  candidate: DetectedApiListCandidate;
}): TaskDefinition {
  const apiList: ApiListTask = {
    kind: 'api_list',
    request: {
      url: options.candidate.request.url,
      method: options.candidate.request.method,
      ...(options.candidate.request.headers ? { headers: options.candidate.request.headers } : {}),
      ...(options.candidate.request.query ? { query: options.candidate.request.query } : {}),
      ...(options.candidate.request.body !== undefined ? { body: options.candidate.request.body } : {})
    },
    ...(options.candidate.pagination ? {
      pagination: {
        type: 'page',
        param: options.candidate.pagination.param,
        start: options.candidate.pagination.start,
        step: options.candidate.pagination.step,
        ...(options.candidate.pagination.pageSizeParam ? { pageSizeParam: options.candidate.pagination.pageSizeParam } : {}),
        ...(options.candidate.pagination.pageSize !== undefined ? { pageSize: options.candidate.pagination.pageSize } : {})
      }
    } : {}),
    itemsPath: options.candidate.itemsPath,
    fields: options.candidate.fields.map(({ samples: _samples, ...field }) => field)
  };
  return {
    taskId: options.taskId,
    taskName: options.taskName,
    xml: '',
    xoml: '',
    fieldNames: apiList.fields.map((field) => field.name),
    apiList,
    detection: {
      url: options.url,
      candidateId: options.candidate.id,
      candidateType: 'api_list',
      mode: 'api_list',
      localOnly: true,
      confidence: options.candidate.confidence,
      reasons: options.candidate.reasons,
      note: 'Generated from browser network JSON response detection. Cloud task save is not supported for apiList tasks yet.'
    }
  };
}

function buildTataCliqSearchTask(options: { url: string; taskId: string; taskName: string }): TaskDefinition {
  const candidate = buildTataCliqSearchCandidate(options.url);
  const apiList = candidateToApiList(candidate);
  return {
    taskId: options.taskId,
    taskName: options.taskName,
    xml: '',
    xoml: '',
    fieldNames: apiList.fields.map((field) => field.name),
    apiList,
    detection: {
      url: options.url,
      candidateId: candidate.id,
      candidateType: 'api_list',
      mode: 'api_list',
      localOnly: true,
      note: 'Generated from a known API-backed SPA search pattern. Cloud task save is not supported for apiList tasks yet.'
    }
  };
}

function buildTataCliqSearchCandidate(url: string): DetectedApiListCandidate {
  const apiList = buildTataCliqSearchApiList(url);
  return {
    id: 'known_api_tatacliq_search',
    type: 'api_list',
    title: 'Tata CLiQ search API list',
    confidence: 0.94,
    request: {
      url: apiList.request.url,
      method: apiList.request.method ?? 'GET',
      ...(apiList.request.headers ? { headers: apiList.request.headers } : {}),
      ...(apiList.request.query ? { query: stringifyQuery(apiList.request.query) } : {})
    },
    ...(apiList.pagination ? {
      pagination: {
        type: 'page',
        param: apiList.pagination.param,
        start: apiList.pagination.start ?? 0,
        step: apiList.pagination.step ?? 1,
        ...(apiList.pagination.pageSizeParam ? { pageSizeParam: apiList.pagination.pageSizeParam } : {}),
        ...(apiList.pagination.pageSize !== undefined ? { pageSize: apiList.pagination.pageSize } : {})
      }
    } : {}),
    itemsPath: apiList.itemsPath,
    fields: apiList.fields.map((field) => ({
      ...field,
      samples: []
    })),
    sampleRows: [],
    itemCount: apiList.pagination?.pageSize ?? 40,
    reasons: [
      'Known Tata CLiQ search API pattern',
      'API response contains product list at $.searchresult',
      'page/pageSize pagination is supported'
    ]
  };
}

function buildTataCliqSearchApiList(url: string): ApiListTask {
  const parsed = new URL(url);
  const text = parsed.searchParams.get('text') || '';
  const searchText = text.includes('inStockFlag:true') ? text : `${text}:inStockFlag:true`;
  return {
    kind: 'api_list',
    request: {
      url: 'https://searchbff.tatacliq.com/products/mpl/search',
      method: 'GET',
      query: {
        searchText,
        isKeywordRedirect: 'false',
        isKeywordRedirectEnabled: 'true',
        channel: 'WEB',
        isMDE: 'true',
        isTextSearch: 'false',
        isFilter: 'false',
        qc: 'false',
        test: 'qcbypass',
        isSuggested: 'false',
        isPwa: 'true',
        typeID: 'all',
        isFilterDataRequired: 'false'
      }
    },
    pagination: {
      type: 'page',
      param: 'page',
      start: 0,
      step: 1,
      pageSizeParam: 'pageSize',
      pageSize: 40
    },
    itemsPath: '$.searchresult',
    fields: [
      { name: 'product_id', path: '$.productId' },
      { name: 'brand', path: '$.brandname' },
      { name: 'name', path: '$.productname' },
      { name: 'selling_price', path: '$.price.sellingPrice.doubleValue', type: 'number' },
      { name: 'selling_price_text', path: '$.price.sellingPrice.formattedValue' },
      { name: 'mrp', path: '$.price.mrpPrice.doubleValue', type: 'number' },
      { name: 'mrp_text', path: '$.price.mrpPrice.formattedValue' },
      { name: 'discount_percent', path: '$.discountPercent' },
      { name: 'rating', path: '$.averageRating', type: 'number' },
      { name: 'rating_count', path: '$.ratingCount', type: 'number' },
      { name: 'review_count', path: '$.totalNoOfReviews', type: 'number' },
      { name: 'in_stock', path: '$.inStockFlag', type: 'boolean' },
      { name: 'category_type', path: '$.productCategoryType' },
      { name: 'color', path: '$.productColor' },
      { name: 'variant_count', path: '$.variantCount' },
      { name: 'product_url', path: '$.webURL', type: 'url', valuePrefix: 'https://www.tatacliq.com' },
      { name: 'image_url', path: '$.imageURL', type: 'url' },
      { name: 'tags', path: '$.productTagsList', type: 'array' }
    ]
  };
}

function candidateToApiList(candidate: DetectedApiListCandidate): ApiListTask {
  return {
    kind: 'api_list',
    request: candidate.request,
    ...(candidate.pagination ? { pagination: candidate.pagination } : {}),
    itemsPath: candidate.itemsPath,
    fields: candidate.fields.map(({ samples: _samples, ...field }) => field)
  };
}

function stringifyQuery(query: Record<string, string | number | boolean>): Record<string, string> {
  return Object.fromEntries(Object.entries(query).map(([key, value]) => [key, String(value)]));
}

function isTataCliqSearchUrl(url: URL): boolean {
  return /(^|\.)tatacliq\.com$/i.test(url.hostname) && url.pathname.replace(/\/+$/, '') === '/search' && Boolean(url.searchParams.get('text'));
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
