import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface CliConfig {
  apiBaseUrl?: string;
  apiEnv?: 'prod' | string;
  updatedAt?: string;
}

export function configFilePath(): string {
  return join(homedir(), '.octoparse', 'config.json');
}

export async function readCliConfig(): Promise<CliConfig> {
  const filePath = configFilePath();
  let raw = '';
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as Partial<CliConfig>;
    return {
      apiBaseUrl: typeof parsed.apiBaseUrl === 'string' ? parsed.apiBaseUrl : undefined,
      apiEnv: typeof parsed.apiEnv === 'string' ? parsed.apiEnv : undefined,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined
    };
  } catch {
    return {};
  }
}

export async function saveCliConfig(config: CliConfig): Promise<CliConfig> {
  const filePath = configFilePath();
  const existing = await readCliConfig();
  const next = {
    ...existing,
    ...config,
    updatedAt: new Date().toISOString()
  };

  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => undefined);
  return next;
}

export async function removeCliConfig(): Promise<boolean> {
  const filePath = configFilePath();
  if (!existsSync(filePath)) return false;
  await unlink(filePath);
  return true;
}
