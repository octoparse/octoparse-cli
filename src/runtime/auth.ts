import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const API_KEY_ENV = 'OCTO_ENGINE_API_KEY';

export type AuthSource = 'env' | 'file' | 'none';

export interface StoredCredentials {
  apiKey: string;
  createdAt: string;
  updatedAt?: string;
}

export interface AuthStatus {
  authenticated: boolean;
  source: AuthSource;
  keyPreview?: string;
  credentialsFile: string;
}

export interface ResolvedAuth extends AuthStatus {
  apiKey?: string;
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

export async function saveApiKey(apiKey: string): Promise<StoredCredentials> {
  const normalized = normalizeApiKey(apiKey);
  if (!normalized) {
    throw new Error('API key cannot be empty');
  }

  const filePath = credentialsFilePath();
  const existing = await readStoredCredentials();
  const now = new Date().toISOString();
  const credentials: StoredCredentials = {
    apiKey: normalized,
    createdAt: existing?.createdAt ?? now,
    updatedAt: existing ? now : undefined
  };

  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => undefined);
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
  const filePath = credentialsFilePath();
  if (envKey) {
    return {
      authenticated: true,
      source: 'env',
      apiKey: envKey,
      keyPreview: maskApiKey(envKey),
      credentialsFile: filePath
    };
  }

  const stored = await readStoredCredentials();
  if (stored?.apiKey) {
    return {
      authenticated: true,
      source: 'file',
      apiKey: stored.apiKey,
      keyPreview: maskApiKey(stored.apiKey),
      credentialsFile: filePath
    };
  }

  return {
    authenticated: false,
    source: 'none',
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
    if (!apiKey) return null;
    return {
      apiKey,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined
    };
  } catch {
    return null;
  }
}
