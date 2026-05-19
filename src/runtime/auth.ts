import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { refreshOAuthToken } from './oauth.js';

export const API_KEY_ENV = 'OCTO_ENGINE_API_KEY';
export const ACCESS_TOKEN_ENV = 'OCTO_ENGINE_ACCESS_TOKEN';

export type AuthSource = 'env' | 'file' | 'none';
export type AuthMethod = 'apiKey' | 'oauth' | 'none';

export interface StoredCredentials {
  method?: AuthMethod;
  apiKey?: string;
  oauth?: StoredOAuthToken;
  createdAt: string;
  updatedAt?: string;
}

export interface StoredOAuthToken {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  tokenType?: string;
  scope?: string;
  expiresIn?: number;
  expiresAtMs?: number;
}

export interface AuthCredential {
  type: 'apiKey' | 'bearer';
  value: string;
}

export interface AuthStatus {
  authenticated: boolean;
  source: AuthSource;
  method: AuthMethod;
  keyPreview?: string;
  tokenPreview?: string;
  expiresAt?: string;
  credentialsFile: string;
}

export interface ResolvedAuth extends AuthStatus {
  apiKey?: string;
  accessToken?: string;
  credential?: AuthCredential;
  oauth?: StoredOAuthToken;
}

export function credentialsFilePath(): string {
  return join(homedir(), '.octoparse', 'credentials.json');
}

export function normalizeApiKey(apiKey: string): string {
  return apiKey.trim();
}

export function maskApiKey(apiKey: string): string {
  const normalized = normalizeApiKey(apiKey);
  if (normalized.length <= 8) return '****';
  return `${normalized.slice(0, 4)}****${normalized.slice(-4)}`;
}

export function maskAccessToken(accessToken: string): string {
  const normalized = normalizeApiKey(accessToken);
  if (normalized.length <= 16) return '****';
  return `${normalized.slice(0, 8)}****${normalized.slice(-8)}`;
}

export async function saveApiKey(apiKey: string): Promise<StoredCredentials> {
  const normalized = normalizeApiKey(apiKey);
  if (!normalized) {
    throw new Error('API key cannot be empty');
  }

  const filePath = credentialsFilePath();
  const existing = await readStoredCredentials();
  const now = new Date().toISOString();
  const credentials: StoredCredentials = {
    method: 'apiKey',
    apiKey: normalized,
    createdAt: existing?.createdAt ?? now,
    updatedAt: existing ? now : undefined
  };

  await writeCredentials(filePath, credentials);
  return credentials;
}

export async function saveOAuthToken(token: StoredOAuthToken): Promise<StoredCredentials> {
  const accessToken = normalizeApiKey(token.accessToken);
  if (!accessToken) {
    throw new Error('access_token cannot be empty');
  }

  const filePath = credentialsFilePath();
  const existing = await readStoredCredentials();
  const now = new Date().toISOString();
  const credentials: StoredCredentials = {
    method: 'oauth',
    oauth: {
      ...token,
      accessToken
    },
    createdAt: existing?.createdAt ?? now,
    updatedAt: existing ? now : undefined
  };

  await writeCredentials(filePath, credentials);
  return credentials;
}

export async function removeApiKey(): Promise<boolean> {
  const filePath = credentialsFilePath();
  if (!existsSync(filePath)) return false;
  await unlink(filePath);
  return true;
}

export async function resolveAuth(): Promise<ResolvedAuth> {
  const envKey = normalizeApiKey(process.env[API_KEY_ENV] ?? '');
  const envAccessToken = normalizeApiKey(process.env[ACCESS_TOKEN_ENV] ?? '');
  const filePath = credentialsFilePath();
  if (envKey) {
    return {
      authenticated: true,
      source: 'env',
      method: 'apiKey',
      apiKey: envKey,
      credential: { type: 'apiKey', value: envKey },
      keyPreview: maskApiKey(envKey),
      credentialsFile: filePath
    };
  }
  if (envAccessToken) {
    return {
      authenticated: true,
      source: 'env',
      method: 'oauth',
      accessToken: envAccessToken,
      credential: { type: 'bearer', value: envAccessToken },
      tokenPreview: maskAccessToken(envAccessToken),
      credentialsFile: filePath
    };
  }

  const stored = await readStoredCredentials();
  if (stored?.method === 'oauth' && stored.oauth?.accessToken) {
    const storedOAuth = stored.oauth;
    const oauth = await refreshStoredOAuthTokenIfNeeded(storedOAuth).catch(() => storedOAuth);
    return {
      authenticated: true,
      source: 'file',
      method: 'oauth',
      accessToken: oauth.accessToken,
      credential: { type: 'bearer', value: oauth.accessToken },
      tokenPreview: maskAccessToken(oauth.accessToken),
      expiresAt: oauth.expiresAtMs ? new Date(oauth.expiresAtMs).toISOString() : undefined,
      oauth,
      credentialsFile: filePath
    };
  }
  if (stored?.apiKey) {
    return {
      authenticated: true,
      source: 'file',
      method: 'apiKey',
      apiKey: stored.apiKey,
      credential: { type: 'apiKey', value: stored.apiKey },
      keyPreview: maskApiKey(stored.apiKey),
      credentialsFile: filePath
    };
  }

  return {
    authenticated: false,
    source: 'none',
    method: 'none',
    credentialsFile: filePath
  };
}

export async function readStoredCredentials(): Promise<StoredCredentials | null> {
  const filePath = credentialsFilePath();
  let raw = '';
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
    const apiKey = normalizeApiKey(String(parsed.apiKey ?? ''));
    const oauth = normalizeStoredOAuthToken(parsed.oauth);
    if (!apiKey && !oauth) return null;
    return {
      method: parsed.method === 'oauth' && oauth ? 'oauth' : 'apiKey',
      apiKey: apiKey || undefined,
      oauth,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined
    };
  } catch {
    return null;
  }
}

function normalizeStoredOAuthToken(value: unknown): StoredOAuthToken | undefined {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const accessToken = normalizeApiKey(String(record?.accessToken ?? ''));
  if (!record || !accessToken) return undefined;
  return {
    accessToken,
    refreshToken: stringValue(record.refreshToken) || undefined,
    idToken: stringValue(record.idToken) || undefined,
    tokenType: stringValue(record.tokenType) || undefined,
    scope: stringValue(record.scope) || undefined,
    expiresIn: numberValue(record.expiresIn),
    expiresAtMs: numberValue(record.expiresAtMs)
  };
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

async function writeCredentials(filePath: string, credentials: StoredCredentials): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => undefined);
}

async function refreshStoredOAuthTokenIfNeeded(token: StoredOAuthToken): Promise<StoredOAuthToken> {
  if (!token.expiresAtMs || !token.refreshToken) return token;
  const refreshSkewMs = 60_000;
  if (token.expiresAtMs - Date.now() > refreshSkewMs) return token;
  const refreshed = await refreshOAuthToken(token);
  await saveOAuthToken(refreshed);
  return refreshed;
}
