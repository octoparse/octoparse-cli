import { readFileSync } from 'node:fs';

const CLIENT_NAME = 'octoparse-cli';

let cachedVersion: string | undefined;

export function clientHeaders(): Record<string, string> {
  const version = clientVersion();
  return {
    'x-client': CLIENT_NAME,
    'x-client-version': version
  };
}

function clientVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const packageJsonUrl = new URL('../../package.json', import.meta.url);
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, 'utf8')) as { version?: string };
    cachedVersion = packageJson.version || '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}
