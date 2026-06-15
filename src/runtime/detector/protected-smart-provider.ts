import { createRequire } from 'node:module';
import type { Page } from 'puppeteer-core';
import { fetchClientServerKey, fetchClientSource } from '../api-client.js';
import { resolveAuth, type AuthCredential } from '../auth.js';

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

export interface SmartExtractItem {
  Name?: string;
  XPath?: string;
  AbsXPath?: string;
  RelativeXPath?: string;
  Attribute?: string;
  LocalName?: string;
  Score?: number;
  Operations?: Array<{ FormatType?: number | string; Params?: string[] }>;
}

export interface SmartListResult {
  xpath?: string;
  scheme?: SmartExtractItem[];
  data?: string[][];
  fullColRate?: number;
}

export interface SmartRawResult {
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

export async function runProtectedSmartDetection(page: Page, options: { baseUrl?: string } = {}): Promise<SmartRawResult> {
  const bundle = await loadProtectedSmartSources(options.baseUrl);
  return runProtectedSmartInPage(page, bundle);
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
      'Temporary workaround: rerun detect with --legacy-detector.'
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
