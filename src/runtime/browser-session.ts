import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { safeFileName } from './naming.js';

export interface BrowserSessionReference {
  name: string;
  origin: string;
  savedAt: string;
  cookieCount: number;
  kind: 'cookie';
  compatibility: 'cookies-only';
  hosts?: string[];
}

export interface BrowserSessionRecord extends BrowserSessionReference {
  cookies: BrowserSessionCookie[];
}

export interface BrowserSessionCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export function defaultSessionNameForUrl(url: string): string {
  try {
    return new URL(url).hostname || 'site';
  } catch {
    return 'site';
  }
}

export function sessionOriginForUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

export function browserSessionPath(name: string): string {
  return join(browserSessionDir(), `${safeFileName(name)}.json`);
}

export async function saveBrowserSession(options: {
  name: string;
  origin: string;
  cookies: BrowserSessionCookie[];
  hosts?: string[];
}): Promise<BrowserSessionReference> {
  const cookies = options.cookies.filter((cookie) => {
    if (!cookie.name || cookie.value === undefined) return false;
    if (typeof cookie.expires === 'number' && cookie.expires > 0 && cookie.expires * 1000 <= Date.now()) return false;
    return true;
  });
  const now = new Date().toISOString();
  const record: BrowserSessionRecord = {
    name: options.name,
    origin: options.origin,
    savedAt: now,
    cookieCount: cookies.length,
    kind: 'cookie',
    compatibility: 'cookies-only',
    ...(options.hosts?.length ? { hosts: Array.from(new Set(options.hosts.map((host) => host.toLowerCase()))) } : {}),
    cookies
  };
  const dir = browserSessionDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  const target = browserSessionPath(options.name);
  const temp = join(dir, `.${safeFileName(options.name)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(temp, 0o600).catch(() => undefined);
  await rename(temp, target);
  await chmod(target, 0o600).catch(() => undefined);
  return sessionReference(record);
}

export async function loadBrowserSession(name: string): Promise<BrowserSessionRecord> {
  const parsed = JSON.parse(await readFile(browserSessionPath(name), 'utf8')) as Partial<BrowserSessionRecord>;
  if (!parsed.name || !parsed.origin || !Array.isArray(parsed.cookies)) {
    throw new Error(`Invalid browser session: ${name}`);
  }
  return {
    name: parsed.name,
    origin: parsed.origin,
    savedAt: parsed.savedAt || '',
    cookieCount: typeof parsed.cookieCount === 'number' ? parsed.cookieCount : parsed.cookies.length,
    kind: 'cookie',
    compatibility: 'cookies-only',
    ...(Array.isArray(parsed.hosts) ? { hosts: parsed.hosts.filter((host): host is string => typeof host === 'string') } : {}),
    cookies: parsed.cookies
  };
}

export function sessionReference(record: BrowserSessionRecord): BrowserSessionReference {
  return {
    name: record.name,
    origin: record.origin,
    savedAt: record.savedAt,
    cookieCount: record.cookieCount,
    kind: 'cookie',
    compatibility: 'cookies-only',
    ...(record.hosts?.length ? { hosts: record.hosts } : {})
  };
}

export function cookieHeaderFromSession(record: Pick<BrowserSessionRecord, 'cookies'>): string {
  return record.cookies
    .filter((cookie) => cookie.name && cookie.value !== undefined)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function browserSessionDir(): string {
  return join(homedir(), '.octoparse', 'browser-sessions');
}
