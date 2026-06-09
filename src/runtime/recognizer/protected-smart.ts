import { createRequire } from 'node:module';
import type { Page } from 'puppeteer-core';
import { fetchClientServerKey, fetchClientSource } from '../api-client.js';
import { resolveAuth } from '../auth.js';
import type { AuthCredential } from '../auth.js';
import type { RecognizedCandidate, RecognizedField, RecognizedPagination } from './types.js';

const require = createRequire(import.meta.url);

const ORZ_RESOURCE_NAME = 'orz.g.zh.1.2.3';
const ODC_RESOURCE_NAME = 'odc.f.zh.1.2.3';

interface ProtectModule {
  vk?: () => string;
  vn?: {
    vf?: (key: string) => string;
    revf?: (verified: string) => boolean;
  };
  en?: {
    ensk?: (verified: string, content: string) => string;
    desk?: (verified: string, content: string) => string;
  };
}

interface SmartExtractItem {
  Name?: string;
  XPath?: string;
  AbsXPath?: string;
  RelativeXPath?: string;
  Attribute?: string;
  LocalName?: string;
  Score?: number;
  Operations?: Array<{ FormatType?: number | string; Params?: string[] }>;
}

interface SmartListResult {
  xpath?: string;
  scheme?: SmartExtractItem[];
  data?: string[][];
  fullColRate?: number;
}

interface SmartRawResult {
  List?: Array<{
    type?: number;
    element?: SmartListResult;
    sort?: number;
    page?: {
      PagingType?: number;
      XPath?: string;
      Text?: string;
      IsAjax?: boolean;
    };
  }>;
  Page?: {
    PagingType?: number;
    XPath?: string;
    Text?: string;
    IsAjax?: boolean;
  };
}

interface ProtectedSourceBundle {
  smartProxySource: string;
  dictionarySource: string;
}

export function protectedSmartRequested(): boolean {
  return process.env.OCTOPARSE_LEGACY_RECOGNIZER !== '1';
}

export async function detectProtectedSmartCandidates(page: Page, options: { maxCandidates: number; baseUrl?: string }): Promise<RecognizedCandidate[]> {
  const bundle = await loadProtectedSmartSources(options.baseUrl);
  const result = await runProtectedSmartInPage(page, bundle);
  return protectedSmartResultToCandidates(result, options.maxCandidates);
}

async function loadProtectedSmartSources(baseUrl?: string): Promise<ProtectedSourceBundle> {
  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) {
    throw new Error('Protected Smart requires authenticated CLI credentials.');
  }
  const protect = loadProtectModule();
  const verified = createVerifiedCode(protect);
  const encryptedServerKey = encryptServerKey(protect, verified, await fetchClientServerKey({ auth: auth.credential, baseUrl }));
  const [orz, odc] = await Promise.all([
    fetchClientSource({ auth: auth.credential as AuthCredential, baseUrl, serverKey: encryptedServerKey, sourceFileName: ORZ_RESOURCE_NAME }),
    fetchClientSource({ auth: auth.credential as AuthCredential, baseUrl, serverKey: encryptedServerKey, sourceFileName: ODC_RESOURCE_NAME })
  ]);
  return {
    smartProxySource: decryptClientSource(protect, verified, orz.encryptedContent),
    dictionarySource: decryptClientSource(protect, verified, odc.encryptedContent)
  };
}

function loadProtectModule(): ProtectModule {
  let loaded: unknown;
  try {
    loaded = require('@octopus/octopus-protect');
  } catch (error) {
    throw new Error(protectModuleLoadErrorMessage(error));
  }
  const module = loaded as { default?: unknown };
  const protect = (module.default ?? loaded) as ProtectModule;
  if (!protect?.vk || !protect.vn?.vf || !protect.vn?.revf || !protect.en?.ensk || !protect.en?.desk) {
    throw new Error('Protected Smart requires the bundled native @octopus/octopus-protect module.');
  }
  return protect;
}

function protectModuleLoadErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const platform = `${process.platform}-${process.arch}`;
  if (/Cannot find native binding|Cannot find module/i.test(message)) {
    return [
      `Protected Smart requires a native @octopus/octopus-protect binding for ${platform}, but it is missing from this installation.`,
      'Reinstall a package version that bundles the matching native binding.',
      'Temporary workaround: rerun recognize with --legacy-recognizer.'
    ].join(' ');
  }
  return `Protected Smart native module failed to load on ${platform}: ${message}`;
}

function createVerifiedCode(protect: ProtectModule): string {
  const code = protect.vn?.vf?.(protect.vk?.() || '') || '';
  if (!code || protect.vn?.revf?.(code) !== true) {
    throw new Error('Protected Smart native verification failed.');
  }
  return code;
}

function encryptServerKey(protect: ProtectModule, verified: string, serverKey: string): string {
  const encrypted = protect.en?.ensk?.(verified, serverKey) || '';
  if (!encrypted) throw new Error('Protected Smart server-key encryption failed.');
  return encrypted;
}

function decryptClientSource(protect: ProtectModule, verified: string, encryptedSource: string): string {
  const source = protect.en?.desk?.(verified, encryptedSource) || '';
  if (!source || source.length < 100) throw new Error('Protected Smart source decryption failed.');
  return source;
}

async function runProtectedSmartInPage(page: Page, bundle: ProtectedSourceBundle): Promise<SmartRawResult> {
  const isolatedRealm = (page.mainFrame() as unknown as {
    isolatedRealm?: () => {
      evaluate: <TArg, TResult>(pageFunction: (arg: TArg) => TResult | Promise<TResult>, arg: TArg) => Promise<TResult>;
    };
  }).isolatedRealm?.();
  if (!isolatedRealm) {
    throw new Error('Protected Smart requires Puppeteer isolated realm support.');
  }
  return isolatedRealm.evaluate(({ smartProxySource, dictionarySource }: ProtectedSourceBundle) => {
    const loadModule = (source: string) => {
      const module = { exports: {} as any };
      const exports = module.exports;
      const fn = new Function('module', 'exports', 'require', source);
      fn(module, exports, () => ({}));
      return module.exports?.default || module.exports?.octopus?.default || module.exports?.octopus || module.exports;
    };
    const dictionary = JSON.parse(dictionarySource);
    const SmartProxy = loadModule(smartProxySource);
    const smartProxy = new SmartProxy();
    const doc = document;
    smartProxy.doc = doc;
    smartProxy.DataExtractor.win = window;
    smartProxy.initDictionary(dictionary, navigator.language || 'en-US');

    const tree = smartProxy.buildTree(doc);
    return Promise.resolve(tree).then(async (visualTree: unknown) => {
      const lists: NonNullable<SmartRawResult['List']> = [];
      const serializePage = (page: any) => page
        ? {
            PagingType: page.PagingType,
            XPath: page.XPath,
            Text: page.Text || page.LocalName || '',
            IsAjax: page.IsAjax === true
          }
        : undefined;
      const extracted = smartProxy.extractor.ExtractList(visualTree, 5)
        .filter((item: any) => item && item.RowXPath && item.Items)
        .map((item: any) => [item.RowXPath, item.Items, item.IsCrossRegion]);
      for (const item of extracted) {
        const res = await smartProxy.extractList(item[0], item[1], item[2]);
        if (res && res.data && res.data.length > 0 && res.data[0].length > 1 && res.fullColRate > 0.27 && lists.length < 5) {
          const candidate: NonNullable<SmartRawResult['List']>[number] = {
            type: 3,
            element: res,
            sort: smartProxy.computeSort(3, res)
          };
          const page = await smartProxy.findPageByNearSection(res.xpath);
          if (page) candidate.page = serializePage(page);
          lists.push(candidate);
        }
      }
      const page = lists.some((item) => item.page)
        ? undefined
        : await smartProxy.extractPage();
      return {
        List: lists,
        ...(page ? { Page: { ...serializePage(page), PagingType: 0 } } : {})
      };
    });
  }, bundle);
}

function protectedSmartResultToCandidates(result: SmartRawResult, maxCandidates: number): RecognizedCandidate[] {
  const lists = (result.List ?? [])
    .filter((item) => item.type === 3 && item.element?.xpath && item.element.scheme?.length)
    .sort((a, b) => (b.sort ?? 0) - (a.sort ?? 0))
    .slice(0, Math.max(1, maxCandidates));
  return lists.map((item, index) => {
    const element = item.element as SmartListResult;
    const fields = (element.scheme ?? [])
      .map((field, fieldIndex) => smartFieldToRecognizedField(element, field, fieldIndex))
      .filter((field): field is RecognizedField => Boolean(field));
    const sampleRows = buildSampleRows(fields, element.data ?? []);
    const pagination = smartPaginationToRecognized(item.page ?? result.Page);
    return {
      id: `protected_smart_${index + 1}`,
      type: fields.some((field) => field.kind === 'href') ? 'search_results' : 'repeated_card',
      title: `Protected Smart list (${element.data?.[0]?.length ?? 0} items)`,
      confidence: Number(Math.max(0.72, Math.min(0.98, 0.8 + (item.sort ?? 0) * 0.04 + (element.fullColRate ?? 0) * 0.08)).toFixed(2)),
      selector: '',
      xpath: element.xpath || '',
      itemSelector: '',
      itemXPath: element.xpath || '',
      itemCount: element.data?.[0]?.length ?? 0,
      fields,
      sampleRows,
      reasons: [
        'Detected by protected SmartProxy resource',
        `fullColRate=${Number(element.fullColRate ?? 0).toFixed(2)}`
      ],
      ...(pagination ? { pagination } : {})
    } satisfies RecognizedCandidate;
  }).filter((candidate) => candidate.fields.length && candidate.itemCount > 0);
}

function smartFieldToRecognizedField(list: SmartListResult, field: SmartExtractItem, index: number): RecognizedField | undefined {
  const relativeXPath = field.RelativeXPath || '';
  const xpath = field.AbsXPath || `${list.xpath || ''}${relativeXPath}`;
  if (!xpath) return undefined;
  const kind = field.Attribute === 'href' ? 'href' : field.Attribute === 'src' ? 'src' : 'text';
  return {
    name: normalizeFieldName(field.Name, kind, index),
    kind,
    selector: '',
    xpath,
    relativeSelector: '',
    relativeXPath,
    samples: (list.data?.[index] ?? []).filter(Boolean).slice(0, 3),
    ...(kind === 'text' ? { operations: [{ type: 'trim', params: ['0'] }] } : {})
  };
}

function normalizeFieldName(name: string | undefined, kind: RecognizedField['kind'], index: number): string {
  const trimmed = (name || '').trim();
  if (trimmed) return trimmed;
  if (kind === 'href') return index === 0 ? 'url' : `url_${index + 1}`;
  if (kind === 'src') return index === 0 ? 'image' : `image_${index + 1}`;
  return index === 0 ? 'text' : `field_${index + 1}`;
}

function buildSampleRows(fields: RecognizedField[], data: string[][]): Record<string, string>[] {
  const rowCount = Math.min(3, data[0]?.length ?? 0);
  const rows: Record<string, string>[] = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row: Record<string, string> = {};
    fields.forEach((field, fieldIndex) => {
      row[field.name] = data[fieldIndex]?.[rowIndex] ?? '';
    });
    rows.push(row);
  }
  return rows;
}

function smartPaginationToRecognized(page: SmartRawResult['Page']): RecognizedPagination | undefined {
  if (!page?.XPath) return undefined;
  const type = page.PagingType === 1 ? 'load_more' : page.PagingType === 2 ? 'scroll' : 'next_page';
  return {
    type,
    xpath: page.XPath,
    text: page.Text || (type === 'load_more' ? 'Load more' : type === 'scroll' ? 'Scroll page' : 'Next page'),
    confidence: 0.86,
    isAjax: page.IsAjax === true || type !== 'next_page',
    scope: 'near_list',
    reasons: ['Detected by protected SmartProxy pagination']
  };
}
