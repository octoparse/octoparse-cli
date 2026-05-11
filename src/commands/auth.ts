import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { firstPositionalArg, hasFlag, valueAfter } from '../cli/args.js';
import { printEnvelope, printUsageError } from '../cli/output.js';
import { API_BASE_URL_ENV, ApiRequestError, validateApiKey } from '../runtime/api-client.js';
import { API_KEY_ENV, maskApiKey, normalizeApiKey, removeApiKey, resolveAuth, saveApiKey } from '../runtime/auth.js';
import { EXIT_OK, EXIT_OPERATION_FAILED } from '../types.js';

export const API_KEYS_URL = 'https://www.octoparse.com/console/account-center/api-keys';

export async function authCommand(subcommand: string | undefined, args: string[]): Promise<number> {
  const json = hasFlag([subcommand ?? '', ...args], '--json');
  if (subcommand === 'login') {
    return authLogin(args);
  }

  if (subcommand === 'status') {
    return authStatus(args);
  }

  if (subcommand === 'logout') {
    return authLogout(args);
  }

  return printUsageError(json, 'Error: invalid auth subcommand', 'Usage: octoparse auth <login|status|logout> [--json]');
}

export async function ensureAuthenticated(json: boolean): Promise<number> {
  const auth = await resolveAuth();
  if (auth.authenticated) return EXIT_OK;

  return printAuthRequired(json);
}

export function printAuthRequired(json: boolean): number {
  const message = [
    'API key required.',
    `Create one at ${API_KEYS_URL}, then run "octoparse auth login".`,
    `For CI, set ${API_KEY_ENV}.`
  ].join(' ');
  if (json) {
    printEnvelope(false, undefined, 'AUTH_REQUIRED', message);
  } else {
    console.error('Authentication failed: an API key is required.');
    console.error('');
    console.error('Create an API key:');
    console.error(`  ${API_KEYS_URL}`);
    console.error('');
    console.error('Then run:');
    console.error('  octoparse auth login');
    console.error('');
    console.error(`For CI or scripts, set ${API_KEY_ENV}.`);
  }
  return EXIT_OPERATION_FAILED;
}

async function authLogin(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const readFromStdin = hasFlag(args, '--stdin');
  const providedApiKey = normalizeApiKey(firstPositionalArg(args, ['--api-base-url']) ?? '');
  const shouldOpen = shouldOpenApiKeyPage(args, json, readFromStdin, Boolean(providedApiKey));

  try {
    if (!providedApiKey && !readFromStdin && !json) {
      printLoginInstructions(shouldOpen);
    }
    if (shouldOpen) {
      await openUrl(API_KEYS_URL);
    }
    const apiKey = providedApiKey
      ? providedApiKey
      : readFromStdin
        ? await readApiKeyFromStdin()
        : await readSecretFromTty('Paste API key: ');
    const validation = await validateApiKey({ apiKey, baseUrl: valueAfter(args, '--api-base-url') });
    const credentials = await saveApiKey(apiKey);
    const status = {
      authenticated: true,
      source: 'file',
      keyPreview: maskApiKey(credentials.apiKey),
      credentialsFile: join(homedir(), '.octoparse', 'credentials.json'),
      verified: true,
      apiBaseUrl: validation.baseUrl
    };

    if (json) {
      printEnvelope(true, status);
    } else {
      console.log(`API key verified and saved: ${status.keyPreview}`);
      console.log(`API: ${status.apiBaseUrl}`);
      console.log(`Credentials: ${status.credentialsFile}`);
      console.log('');
      console.log('Next:');
      console.log('  octoparse task list');
    }
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof ApiRequestError ? error.code : 'AUTH_LOGIN_FAILED';
    if (json) printEnvelope(false, undefined, code, message);
    else {
      console.error(`Login failed: ${message}`);
      console.error('API key was not saved.');
      if (code === 'AUTH_INVALID') {
        console.error('');
        console.error('Check:');
        console.error('  1. Whether the full API key was copied');
        console.error(`  2. Whether the API key belongs to the current API environment, or check ${API_BASE_URL_ENV} / env status`);
        console.error(`  3. Create a new API key: ${API_KEYS_URL}`);
      }
    }
    return EXIT_OPERATION_FAILED;
  }
}

function printLoginInstructions(willOpenBrowser: boolean): void {
  console.log('Octo Engine uses your Octoparse API key to verify your account and access tasks.');
  console.log('');
  if (willOpenBrowser) {
    console.log('Opening API key page:');
  } else {
    console.log('Create API key:');
  }
  console.log(`  ${API_KEYS_URL}`);
  console.log('');
  if (willOpenBrowser) {
    console.log('If the browser did not open, copy the URL above.');
  }
  console.log('Create an API key in the browser, then paste it here.');
  console.log('The key will be verified before it is saved locally.');
  console.log('');
}

function shouldOpenApiKeyPage(args: string[], json: boolean, readFromStdin: boolean, hasProvidedApiKey: boolean): boolean {
  if (json || readFromStdin || hasProvidedApiKey || hasFlag(args, '--no-open')) return false;
  if (process.env.CI === 'true') return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function openUrl(url: string): Promise<void> {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32'
    ? ['/c', 'start', '', url]
    : [url];

  return new Promise((resolveOpen) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore'
    });
    child.on('error', () => resolveOpen());
    child.unref();
    resolveOpen();
  });
}

async function authStatus(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const { apiKey: _apiKey, ...status } = await resolveAuth();

  if (json) {
    printEnvelope(true, status);
    return EXIT_OK;
  }

  if (!status.authenticated) {
    console.log('Not authenticated');
    console.log('Run: octoparse auth login');
    return EXIT_OK;
  }

  console.log(`Authenticated: yes (${status.source})`);
  console.log(`API key: ${status.keyPreview}`);
  if (status.source === 'env') {
    console.log(`Source: ${API_KEY_ENV}`);
  } else {
    console.log(`Credentials: ${status.credentialsFile}`);
  }
  return EXIT_OK;
}

async function authLogout(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const removed = await removeApiKey();
  const { apiKey: _apiKey, ...status } = await resolveAuth();
  const result = { removed, ...status };

  if (json) {
    printEnvelope(true, result);
    return EXIT_OK;
  }

  console.log(removed ? 'Stored API key removed' : 'No stored API key found');
  if (status.authenticated && status.source === 'env') {
    console.log(`${API_KEY_ENV} is still set and will continue to be used for this shell.`);
  }
  return EXIT_OK;
}

async function readApiKeyFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error('Pass the API key through stdin when using --stdin');
  }

  let value = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    value += chunk;
  }
  const apiKey = value.trim();
  if (!apiKey) throw new Error('API key cannot be empty');
  return apiKey;
}

function readSecretFromTty(prompt: string): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) {
    return Promise.reject(new Error('This is not an interactive terminal; use --stdin'));
  }

  return new Promise((resolveSecret, rejectSecret) => {
    let value = '';
    const wasRaw = stdin.isRaw;

    const cleanup = () => {
      stdin.off('data', handleData);
      if (stdin.setRawMode) stdin.setRawMode(wasRaw);
      stdout.write('\n');
    };

    const finish = () => {
      cleanup();
      const apiKey = value.trim();
      apiKey ? resolveSecret(apiKey) : rejectSecret(new Error('API key cannot be empty'));
    };

    const handleData = (chunk: Buffer) => {
      const input = chunk.toString('utf8');
      for (const char of input) {
        if (char === '\u0003') {
          cleanup();
          rejectSecret(new Error('Cancelled'));
          return;
        }
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= ' ') {
          value += char;
        }
      }
    };

    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', handleData);
  });
}
