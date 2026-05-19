import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import prompts from 'prompts';
import { firstPositionalArg, hasFlag, valueAfter } from '../cli/args.js';
import { printEnvelope, printUsageError } from '../cli/output.js';
import { API_BASE_URL_ENV, ApiRequestError, fetchAccountBalance, fetchAccountInfo, validateApiKey } from '../runtime/api-client.js';
import {
  ACCESS_TOKEN_ENV,
  API_KEY_ENV,
  maskAccessToken,
  maskApiKey,
  normalizeApiKey,
  removeApiKey,
  resolveAuth,
  saveApiKey,
  saveOAuthToken
} from '../runtime/auth.js';
import { buildEndSessionUrl, resolveOAuthConfig, runOAuthLogin } from '../runtime/oauth.js';
import { EXIT_OK, EXIT_OPERATION_FAILED } from '../types.js';

export const API_KEYS_URL = 'https://www.octoparse.com/console/account-center/api-keys';

const ACCOUNT_LEVEL_NAMES = new Map<number, string>([
  [1, 'Free'],
  [2, 'Standard'],
  [3, 'Professional'],
  [4, 'Private Cloud'],
  [11, 'Basic'],
  [31, 'Ultimate Plus'],
  [110, 'Personal'],
  [120, 'Team'],
  [130, 'Business'],
  [140, 'Business Member']
]);

export async function authCommand(subcommand: string | undefined, args: string[]): Promise<number> {
  const json = hasFlag([subcommand ?? '', ...args], '--json');
  if (subcommand === 'login') {
    return authLogin(args);
  }

  if (subcommand === 'status') {
    return authStatus(args);
  }

  if (subcommand === 'info') {
    return authInfo(args);
  }

  if (subcommand === 'logout') {
    return authLogout(args);
  }

  return printUsageError(json, 'Error: invalid auth subcommand', 'Usage: octoparse auth <login|status|info|logout> [--json]');
}

export async function ensureAuthenticated(json: boolean): Promise<number> {
  const auth = await resolveAuth();
  if (auth.authenticated) return EXIT_OK;

  return printAuthRequired(json);
}

export function printAuthRequired(json: boolean): number {
  const message = [
    'Authentication required.',
    'Run "octoparse auth login" and choose OAuth or API key.',
    `API keys can be created at ${API_KEYS_URL}.`,
    `For CI, set ${API_KEY_ENV} or ${ACCESS_TOKEN_ENV}.`
  ].join(' ');
  if (json) {
    printEnvelope(false, undefined, 'AUTH_REQUIRED', message);
  } else {
    console.error('Authentication failed: login is required.');
    console.error('');
    console.error('Then run:');
    console.error('  octoparse auth login');
    console.error('');
    console.error(`For CI or scripts, set ${API_KEY_ENV} or ${ACCESS_TOKEN_ENV}.`);
  }
  return EXIT_OPERATION_FAILED;
}

async function authLogin(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const readFromStdin = hasFlag(args, '--stdin');
  const providedApiKey = normalizeApiKey(firstPositionalArg(args, ['--api-base-url']) ?? '');
  const method = await resolveLoginMethod(args, json, readFromStdin, Boolean(providedApiKey));
  if (method === 'oauth') {
    return authLoginOAuth(args);
  }
  return authLoginApiKey(args, json, readFromStdin, providedApiKey);
}

async function authLoginApiKey(args: string[], json: boolean, readFromStdin: boolean, providedApiKey: string): Promise<number> {
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
      method: 'apiKey',
      keyPreview: maskApiKey(credentials.apiKey ?? apiKey),
      credentialsFile: join(homedir(), '.octoparse', 'credentials.json'),
      ...verifiedAccountFields(validation)
    };

    if (json) {
      printEnvelope(true, status);
    } else {
      console.log(`API key verified and saved: ${status.keyPreview}`);
      console.log(`API: ${status.apiBaseUrl}`);
      if (status.currentAccountLevel !== undefined) {
        console.log(`Account plan: ${formatAccountLevel(status.currentAccountLevel, status.currentAccountLevelName)}`);
      }
      if (status.accountBalance !== undefined) {
        console.log(`Account balance: ${status.accountBalance}`);
      }
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

async function authLoginOAuth(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const shouldOpen = !hasFlag(args, '--no-open');
  try {
    const config = resolveOAuthConfig();
    if (!json) {
      console.log('Opening browser for OAuth login.');
      console.log('');
    }
    const result = await runOAuthLogin({
      config,
      openBrowser: async (url) => {
        process.stderr.write(`Open this URL to log in:\n${url}\n`);
        if (shouldOpen) await openUrl(url);
      }
    });
    const credentials = await saveOAuthToken(result.token);
    const status = {
      authenticated: true,
      source: 'file',
      method: 'oauth',
      tokenPreview: maskAccessToken(result.token.accessToken),
      credentialsFile: join(homedir(), '.octoparse', 'credentials.json')
    };

    if (json) {
      printEnvelope(true, status);
    } else {
      console.log(`OAuth token saved: ${status.tokenPreview}`);
      console.log(`Credentials: ${status.credentialsFile}`);
      console.log('');
      console.log('Next:');
      console.log('  octoparse task list');
    }
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) printEnvelope(false, undefined, 'OAUTH_LOGIN_FAILED', message);
    else {
      console.error(`OAuth login failed: ${message}`);
      console.error('Token was not saved.');
    }
    return EXIT_OPERATION_FAILED;
  }
}

async function resolveLoginMethod(args: string[], json: boolean, readFromStdin: boolean, hasProvidedApiKey: boolean): Promise<'oauth' | 'apiKey'> {
  if (hasFlag(args, '--oauth')) return 'oauth';
  if (hasFlag(args, '--api-key')) return 'apiKey';
  if (readFromStdin || hasProvidedApiKey || json) return 'apiKey';
  if (!process.stdin.isTTY || !process.stdout.isTTY) return 'apiKey';
  const response = await prompts({
    type: 'select',
    name: 'method',
    message: 'Choose login method',
    choices: [
      { title: 'OAuth login (opens browser)', value: 'oauth' },
      { title: 'API key', value: 'apiKey' }
    ],
    initial: 0
  });
  return response.method === 'apiKey' ? 'apiKey' : 'oauth';
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
  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) {
    if (json) {
      return printAuthRequired(true);
    }
    console.log('Not authenticated');
    console.log('Run: octoparse auth login');
    return EXIT_OPERATION_FAILED;
  }

  try {
    const validation = auth.apiKey
      ? await validateApiKey({
          apiKey: auth.apiKey,
          baseUrl: valueAfter(args, '--api-base-url')
        })
      : await validateCredential(auth.credential, valueAfter(args, '--api-base-url'));
    const { apiKey: _apiKey, accessToken: _accessToken, oauth: _oauth, credential: _credential, ...status } = auth;
    const result = {
      ...status,
      ...verifiedAccountFields(validation)
    };

    if (json) {
      printEnvelope(true, result);
      return EXIT_OK;
    }

    console.log(`Authenticated: yes (${status.source})`);
    console.log(`Method: ${status.method}`);
    console.log('Verified: yes');
    console.log(`API: ${validation.baseUrl}`);
    if (result.currentAccountLevel !== undefined) {
      console.log(`Account plan: ${formatAccountLevel(result.currentAccountLevel, result.currentAccountLevelName)}`);
    }
    if (result.accountBalance !== undefined) {
      console.log(`Account balance: ${result.accountBalance}`);
    }
    if (status.method === 'oauth') {
      console.log(`Access token: ${status.tokenPreview}`);
    } else {
      console.log(`API key: ${status.keyPreview}`);
    }
    if (status.source === 'env') {
      console.log(`Source: ${status.method === 'oauth' ? ACCESS_TOKEN_ENV : API_KEY_ENV}`);
    } else {
      console.log(`Credentials: ${status.credentialsFile}`);
    }
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof ApiRequestError ? error.code : 'AUTH_STATUS_FAILED';
    if (json) {
      printEnvelope(false, undefined, code, message);
    } else {
      console.error(`Authentication failed: ${message}`);
      if (code === 'AUTH_INVALID') {
        console.error('Re-login with: octoparse auth login');
      }
    }
    return EXIT_OPERATION_FAILED;
  }
}

async function authInfo(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) {
    return printAuthRequired(json);
  }

  try {
    const validation = auth.apiKey
      ? await validateApiKey({
          apiKey: auth.apiKey,
          baseUrl: valueAfter(args, '--api-base-url')
        })
      : await validateCredential(auth.credential, valueAfter(args, '--api-base-url'));
    const { apiKey: _apiKey, accessToken: _accessToken, oauth: _oauth, credential: _credential, ...status } = auth;
    const result = {
      ...status,
      ...verifiedAccountFields(validation),
      account: validation.account
    };

    if (json) {
      printEnvelope(true, result);
      return EXIT_OK;
    }

    printAccountInfo(result);
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof ApiRequestError ? error.code : 'AUTH_INFO_FAILED';
    if (json) {
      printEnvelope(false, undefined, code, message);
    } else {
      console.error(`Failed to get account info: ${message}`);
      if (code === 'AUTH_INVALID') {
        console.error('Re-login with: octoparse auth login');
      }
    }
    return EXIT_OPERATION_FAILED;
  }
}

async function authLogout(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const before = await resolveAuth();
  const logoutUrl = before.method === 'oauth'
    ? buildEndSessionUrl(resolveOAuthConfig(), before.oauth)
    : undefined;
  const removed = await removeApiKey();
  const { apiKey: _apiKey, accessToken: _accessToken, oauth: _oauth, credential: _credential, ...status } = await resolveAuth();
  const result = { removed, logoutUrl, ...status };

  if (json) {
    printEnvelope(true, result);
    return EXIT_OK;
  }

  console.log(removed ? 'Stored credentials removed' : 'No stored credentials found');
  if (logoutUrl) console.log(`Identity logout: ${logoutUrl}`);
  if (status.authenticated && status.source === 'env') {
    console.log(`${status.method === 'oauth' ? ACCESS_TOKEN_ENV : API_KEY_ENV} is still set and will continue to be used for this shell.`);
  }
  return EXIT_OK;
}

async function validateCredential(credential: NonNullable<Awaited<ReturnType<typeof resolveAuth>>['credential']>, baseUrl?: string) {
  const account = await fetchAccountInfo({ auth: credential, baseUrl });
  const balance = await fetchAccountBalance({ auth: credential, baseUrl }).catch(() => undefined);
  return {
    ok: true as const,
    baseUrl: account.baseUrl,
    endpoint: account.endpoint,
    account: account.data,
    balance
  };
}

function accountLevelName(level: unknown): string | undefined {
  return typeof level === 'number' ? ACCOUNT_LEVEL_NAMES.get(level) : undefined;
}

function formatAccountLevel(level: number, name: string | undefined): string {
  return name ?? String(level);
}

function verifiedAccountFields(validation: Awaited<ReturnType<typeof validateApiKey>>) {
  return {
    verified: true,
    apiBaseUrl: validation.baseUrl,
    currentAccountLevel: validation.account.currentAccountLevel ?? validation.account.type,
    currentAccountLevelName: accountLevelName(validation.account.currentAccountLevel ?? validation.account.type),
    accountBalance: validation.balance?.totalBalance ?? validation.balance?.balance ?? validation.account.accountBalance
  };
}

function printAccountInfo(result: ReturnType<typeof verifiedAccountFields> & {
  authenticated: boolean;
  source: string;
  method: string;
  keyPreview?: string;
  tokenPreview?: string;
  credentialsFile: string;
  account: Record<string, unknown>;
}): void {
  console.log(`Authenticated: yes (${result.source})`);
  const userName = stringField(result.account.userName);
  const email = stringField(result.account.email);
  const mobile = stringField(result.account.mobile);
  const userId = stringField(result.account.userId);
  if (userName) console.log(`User name: ${userName}`);
  if (email) console.log(`Email: ${email}`);
  if (mobile) console.log(`Mobile: ${mobile}`);
  if (userId) console.log(`User ID: ${userId}`);
  if (result.currentAccountLevel !== undefined) {
    console.log(`Account plan: ${formatAccountLevel(result.currentAccountLevel, result.currentAccountLevelName)}`);
  }
  if (result.accountBalance !== undefined) {
    console.log(`Account balance: ${result.accountBalance}`);
  }
  const effectiveDate = stringField(result.account.effectiveDate);
  if (effectiveDate) console.log(`Effective date: ${effectiveDate}`);
  console.log(`Method: ${result.method}`);
  if (result.method === 'oauth') {
    console.log(`Access token: ${result.tokenPreview}`);
  } else {
    console.log(`API key: ${result.keyPreview}`);
  }
  if (result.source === 'env') console.log(`Source: ${result.method === 'oauth' ? ACCESS_TOKEN_ENV : API_KEY_ENV}`);
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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
      stdin.pause();
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
