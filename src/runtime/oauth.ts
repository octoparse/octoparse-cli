import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { URLSearchParams } from 'node:url';
import type { StoredOAuthToken } from './auth.js';

export const OAUTH_AUTHORITY_ENV = 'OCTO_ENGINE_OAUTH_AUTHORITY';
export const OAUTH_CLIENT_ID_ENV = 'OCTO_ENGINE_OAUTH_CLIENT_ID';
export const OAUTH_CLIENT_SECRET_ENV = 'OCTO_ENGINE_OAUTH_CLIENT_SECRET';
export const OAUTH_REDIRECT_URI_ENV = 'OCTO_ENGINE_OAUTH_REDIRECT_URI';
export const OAUTH_SCOPE_ENV = 'OCTO_ENGINE_OAUTH_SCOPE';

export const DEFAULT_OAUTH_AUTHORITY = 'https://identity.octoparse.com';
export const DEFAULT_OAUTH_CLIENT_ID = 'octoparse-cli';
export const DEFAULT_OAUTH_CLIENT_SECRET = '*';
export const DEFAULT_OAUTH_REDIRECT_PORTS = [18784, 18785, 18786, 18787, 18788] as const;
export const DEFAULT_OAUTH_REDIRECT_URI = `http://localhost:${DEFAULT_OAUTH_REDIRECT_PORTS[0]}/login-callback`;
export const DEFAULT_OAUTH_SCOPE = 'openid profile offline_access';
export const DEFAULT_OAUTH_LOGIN_TIMEOUT_MS = 120_000;

export interface OAuthConfig {
  authority: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string;
}

export interface OAuthLoginResult {
  token: StoredOAuthToken;
  config: OAuthConfig;
}

export function resolveOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig {
  return {
    authority: normalizeAuthority(env[OAUTH_AUTHORITY_ENV] ?? DEFAULT_OAUTH_AUTHORITY),
    clientId: env[OAUTH_CLIENT_ID_ENV]?.trim() || DEFAULT_OAUTH_CLIENT_ID,
    clientSecret: env[OAUTH_CLIENT_SECRET_ENV]?.trim() || DEFAULT_OAUTH_CLIENT_SECRET,
    redirectUri: env[OAUTH_REDIRECT_URI_ENV]?.trim() || DEFAULT_OAUTH_REDIRECT_URI,
    scope: env[OAUTH_SCOPE_ENV]?.trim() || DEFAULT_OAUTH_SCOPE
  };
}

export function buildAuthorizeUrl(config: OAuthConfig, state: string, nonce: string, nextUrl = '/'): string {
  const query = new URLSearchParams({
    client_id: config.clientId,
    scope: config.scope,
    response_type: 'code',
    redirect_uri: config.redirectUri,
    nonce,
    state,
    nextUrl
  });
  return `${config.authority}/connect/authorize?${query.toString()}`;
}

export function buildEndSessionUrl(config: OAuthConfig, token?: StoredOAuthToken, postLogoutRedirectUri?: string): string {
  const redirectUri = postLogoutRedirectUri ?? new URL('/', config.redirectUri).toString();
  const query = new URLSearchParams({ post_logout_redirect_uri: redirectUri });
  if (token?.idToken) query.set('id_token_hint', token.idToken);
  return `${config.authority}/connect/endsession?${query.toString()}`;
}

export async function runOAuthLogin(options: {
  config?: OAuthConfig;
  openBrowser: (url: string) => Promise<void>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<OAuthLoginResult> {
  const config = options.config ?? resolveOAuthConfig();
  const state = randomToken();
  const nonce = randomToken();
  const timeoutMs = options.timeoutMs ?? DEFAULT_OAUTH_LOGIN_TIMEOUT_MS;
  let activeConfig = config;
  let activeServer: Awaited<ReturnType<typeof listenOnFirstAvailableRedirect>>['server'] | undefined;

  return await new Promise<OAuthLoginResult>((resolveLogin, rejectLogin) => {
    const handler = async (request: IncomingMessage, response: ServerResponse<IncomingMessage>) => {
      try {
        const url = new URL(request.url ?? '/', activeConfig.redirectUri);
        const redirect = new URL(activeConfig.redirectUri);
        if (request.method !== 'GET' || url.pathname !== redirect.pathname) {
          sendHtml(response, 404, 'Not found');
          return;
        }

        const error = url.searchParams.get('error');
        if (error) {
          sendHtml(response, 400, renderStatusPage('Login failed', `${error}: ${url.searchParams.get('error_description') ?? ''}`));
          rejectLogin(new Error(`Identity server returned an error: ${error}`));
          return;
        }

        const returnedState = url.searchParams.get('state');
        if (!returnedState || returnedState !== state) {
          sendHtml(response, 400, renderStatusPage('Login failed', 'State validation failed. Try logging in again.'));
          rejectLogin(new Error('Invalid OAuth state. Login response was rejected.'));
          return;
        }

        const code = url.searchParams.get('code');
        if (!code) {
          sendHtml(response, 400, renderStatusPage('Login failed', 'The callback is missing an authorization code.'));
          rejectLogin(new Error('OAuth callback is missing authorization code.'));
          return;
        }

        const token = await exchangeCodeForToken(code, activeConfig, options.fetchImpl);
        sendHtml(response, 200, renderStatusPage('Login successful', 'You can close this browser window and return to the terminal.'));
        resolveLogin({ token, config: activeConfig });
      } catch (error) {
        sendHtml(response, 500, renderStatusPage('Login failed', error instanceof Error ? error.message : String(error)));
        rejectLogin(error);
      }
    };

    void listenOnFirstAvailableRedirect(config, handler)
      .then(({ server, redirectUri }) => {
        activeServer = server;
        activeConfig = { ...config, redirectUri };
        const authorizeUrl = buildAuthorizeUrl(activeConfig, state, nonce);
        server.on('error', rejectLogin);
        return options.openBrowser(authorizeUrl);
      })
      .catch(rejectLogin);

    const timer = setTimeout(() => {
      rejectLogin(new Error('OAuth login timed out.'));
    }, timeoutMs);

    const wrapResolve = resolveLogin;
    const wrapReject = rejectLogin;
    resolveLogin = (value) => {
      clearTimeout(timer);
      activeServer?.close();
      wrapResolve(value);
    };
    rejectLogin = (reason) => {
      clearTimeout(timer);
      activeServer?.close();
      wrapReject(reason);
    };
  });
}

export async function exchangeCodeForToken(code: string, config: OAuthConfig, fetchImpl: typeof fetch = fetch): Promise<StoredOAuthToken> {
  return tokenRequest({
    config,
    fetchImpl,
    payload: {
      grant_type: 'authorization_code',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri
    }
  });
}

export async function refreshOAuthToken(token: StoredOAuthToken, config: OAuthConfig = resolveOAuthConfig(), fetchImpl: typeof fetch = fetch): Promise<StoredOAuthToken> {
  if (!token.refreshToken) {
    throw new Error('Current OAuth token does not include refresh_token.');
  }
  const nextToken = await tokenRequest({
    config,
    fetchImpl,
    payload: {
      grant_type: 'refresh_token',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: token.refreshToken
    }
  });
  return {
    ...nextToken,
    refreshToken: nextToken.refreshToken ?? token.refreshToken,
    idToken: nextToken.idToken ?? token.idToken
  };
}

async function tokenRequest(options: {
  config: OAuthConfig;
  fetchImpl: typeof fetch;
  payload: Record<string, string>;
}): Promise<StoredOAuthToken> {
  const response = await options.fetchImpl(`${options.config.authority}/connect/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(options.payload).toString()
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Token endpoint returned HTTP ${response.status}: ${text}`);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('Token endpoint response is not valid JSON.');
  }
  const accessToken = stringValue(payload.access_token);
  if (!accessToken) throw new Error('Token endpoint response is missing access_token.');
  const expiresIn = numberValue(payload.expires_in);
  return {
    accessToken,
    refreshToken: stringValue(payload.refresh_token) || undefined,
    idToken: stringValue(payload.id_token) || undefined,
    tokenType: stringValue(payload.token_type) || undefined,
    scope: stringValue(payload.scope) || undefined,
    expiresIn,
    expiresAtMs: expiresIn === undefined ? undefined : Date.now() + normalizeExpiresInMs(expiresIn)
  };
}

function normalizeAuthority(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

async function listenOnFirstAvailableRedirect(
  config: OAuthConfig,
  handler: (request: IncomingMessage, response: ServerResponse<IncomingMessage>) => void
): Promise<{ server: ReturnType<typeof createServer>; redirectUri: string }> {
  const candidates = redirectUriCandidates(config);
  const failures: string[] = [];
  for (const redirect of candidates) {
    const server = createServer(handler);
    try {
      await listen(server, redirect);
      return { server, redirectUri: redirect.toString() };
    } catch (error) {
      server.close();
      failures.push(`${redirect.host}: ${error instanceof Error ? error.message : String(error)}`);
      if (!isPortUnavailable(error)) throw error;
    }
  }
  throw new Error(`OAuth callback ports are unavailable: ${failures.join('; ')}`);
}

function redirectUriCandidates(config: OAuthConfig): URL[] {
  const configured = new URL(config.redirectUri);
  if (config.redirectUri !== DEFAULT_OAUTH_REDIRECT_URI) return [configured];
  return DEFAULT_OAUTH_REDIRECT_PORTS.map((port) => {
    const redirect = new URL(config.redirectUri);
    redirect.hostname = 'localhost';
    redirect.port = String(port);
    return redirect;
  });
}

function listen(server: ReturnType<typeof createServer>, redirect: URL): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(Number(redirect.port), redirect.hostname);
  });
}

function isPortUnavailable(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return code === 'EADDRINUSE' || code === 'EACCES' || code === 'EPERM';
}

function sendHtml(response: ServerResponse<IncomingMessage>, status: number, html: string): void {
  const body = Buffer.from(html, 'utf8');
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(body.length)
  });
  response.end(body);
}

function renderStatusPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family: system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; padding: 32px;">
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
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

function normalizeExpiresInMs(expiresIn: number): number {
  return expiresIn > 86_400 ? expiresIn : expiresIn * 1000;
}
