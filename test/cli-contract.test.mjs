import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { authCommand } from '../dist/commands/auth.js';
import { cloudHistory } from '../dist/commands/cloud.js';
import { ApiRequestError, fetchAccountInfo, validateApiKey } from '../dist/runtime/api-client.js';
import { localDataExportCommand } from '../dist/commands/run.js';
import { resolveProxy, solveCaptcha } from '../dist/runtime/run-services.js';
import { formatTaskListLine } from '../dist/commands/task.js';
import { TaskDefinitionProvider } from '../dist/runtime/task-definition-provider.js';

const execFileAsync = promisify(execFile);
const cli = resolve('dist/index.js');

async function runCli(args, options = {}) {
  try {
    const result = await execFileAsync(process.execPath, [cli, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: options.home ?? await mkdtemp(join(tmpdir(), 'octo-home-')),
        ...(options.apiKey ? { OCTO_ENGINE_API_KEY: options.apiKey } : {}),
        ...(options.apiBaseUrl ? { OCTO_ENGINE_API_BASE_URL: options.apiBaseUrl } : {})
      },
      timeout: options.timeout ?? 20_000
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? ''
    };
  }
}

async function runCliWithStdin(args, input, options = {}) {
  return await new Promise((resolveResult) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: options.home ?? '',
        ...(options.apiBaseUrl ? { OCTO_ENGINE_API_BASE_URL: options.apiBaseUrl } : {})
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 20_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolveResult({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function parseJson(stdout) {
  return JSON.parse(stdout);
}

function assertJsonEnvelope(result) {
  assert.doesNotThrow(() => parseJson(result.stdout), result.stdout || result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 1);
}

function formatCliResult(result, args = []) {
  const command = args.length ? ` args=${args.join(' ')}` : '';
  return `${command} code=${result.code} stdout=${result.stdout} stderr=${result.stderr}`;
}

function assertJsonFailure(result, code, exitCode = 1, args = []) {
  assert.equal(result.code, exitCode, formatCliResult(result, args));
  assertJsonEnvelope(result);
  const payload = parseJson(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, code);
  return payload;
}

function assertJsonSuccess(result, args = []) {
  assert.equal(result.code, 0, formatCliResult(result, args));
  assertJsonEnvelope(result);
  const payload = parseJson(result.stdout);
  assert.equal(payload.ok, true);
  return payload;
}

test('functional commands require API key even for local task files', async () => {
  const result = await runCli([
    'task',
    'validate',
    'minimal',
    '--task-file',
    'examples/minimal-task.json',
    '--json'
  ]);
  assert.equal(result.code, 1);
  const payload = parseJson(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'AUTH_REQUIRED');
  assert.match(payload.error.message, /octoparse\.com\/console\/account-center\/api-keys/);
  assert.match(payload.error.message, /octoparse auth login/);
});

test('capabilities is available before authentication and documents API key contract', async () => {
  const result = await runCli(['capabilities', '--json']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const payload = parseJson(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.authentication.requiredForUse, true);
  assert.equal(payload.data.authentication.loginVerifiesKeyBeforeSaving, true);
  assert.equal(payload.data.authentication.env, 'OCTO_ENGINE_API_KEY');
  assert.ok(payload.data.authentication.diagnosticCommandsWithoutAuth.includes('capabilities'));
  assert.ok(payload.data.commands.find((item) => item.command === 'run <taskId>')?.authRequired);
  assert.equal(payload.data.machineContract.stable, true);
  assert.equal(payload.data.machineContract.json.usageErrorsUseEnvelope, true);
  assert.ok(payload.data.machineContract.json.commonErrorCodes.includes('AUTH_REQUIRED'));
  assert.ok(payload.data.machineContract.json.commonErrorCodes.includes('AUTH_INVALID'));
  assert.ok(payload.data.machineContract.jsonl.stableEvents.includes('run.stopped'));
  assert.equal(payload.data.machineContract.lifecycle.daemonRequired, false);
  assert.ok(payload.data.machineContract.lifecycle.cleanupCommands.includes('local cleanup'));
  const schemas = payload.data.machineContract.schemas;
  assert.deepEqual(Object.keys(schemas).sort(), [
    'capabilities',
    'detachedBootstrap',
    'jsonEnvelope',
    'runEvent'
  ]);
  for (const schemaPath of Object.values(schemas)) {
    const schema = JSON.parse(await readFile(resolve(schemaPath), 'utf8'));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.match(schema.$id, /^https:\/\/octoparse\.local\/schemas\//);
  }
});

test('auth login verifies API key before saving', async () => {
  const home = await mkdtemp(join(tmpdir(), 'octo-auth-invalid-'));
  const result = await runCliWithStdin(
    ['auth', 'login', '--stdin', '--json', '--api-base-url', 'http://127.0.0.1:9'],
    'bad-key\n',
    { home }
  );
  assertJsonFailure(result, 'AUTH_LOGIN_FAILED');
  await assert.rejects(access(join(home, '.octoparse', 'credentials.json')));
});

test('auth login accepts API key as a positional argument', async () => {
  const home = await mkdtemp(join(tmpdir(), 'octo-auth-arg-'));
  const originalHome = process.env.HOME;
  const seen = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  process.env.HOME = home;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers ?? {} });
    return new Response(JSON.stringify({
      isSuccess: true,
      data: {
        userId: 'u_arg',
        email: 'arg@example.com'
      }
    }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = () => undefined;
  try {
    const code = await authCommand('login', [
      'arg-key-123',
      '--json',
      '--api-base-url',
      'https://example.invalid'
    ]);
    assert.equal(code, 0);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://example.invalid/api/account/getAccount');
    assert.equal(seen[0].headers['x-api-key'], 'arg-key-123');
    const credentials = JSON.parse(await readFile(join(home, '.octoparse', 'credentials.json'), 'utf8'));
    assert.equal(credentials.apiKey, 'arg-key-123');
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test('invalid API key maps to friendly auth error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: 'unauthorized',
    error_Description: 'An error occurred during API Key verification.'
  }), {
    status: 401,
    statusText: 'Unauthorized',
    headers: { 'content-type': 'application/json' }
  });
  try {
    await assert.rejects(
      validateApiKey({ apiKey: 'bad-key', baseUrl: 'https://example.invalid' }),
      (error) => {
        assert.equal(error instanceof ApiRequestError, true);
        assert.equal(error.code, 'AUTH_INVALID');
        assert.equal(error.status, 401);
        assert.match(error.message, /API key is invalid/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('account info uses electron getAccount endpoint', async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers ?? {} });
    return new Response(JSON.stringify({
      isSuccess: true,
      data: {
        userId: 'u_1',
        email: 'user@example.com',
        userName: 'Example User',
        type: 2,
        currentAccountLevel: 2,
        effectiveDate: '2026-12-31T00:00:00Z'
      }
    }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };
  try {
    const result = await fetchAccountInfo({ apiKey: 'test-key', baseUrl: 'https://example.invalid' });
    assert.equal(result.endpoint, '/api/account/getAccount');
    assert.equal(result.data.userId, 'u_1');
    assert.equal(result.data.email, 'user@example.com');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://example.invalid/api/account/getAccount');
    assert.equal(seen[0].headers['x-api-key'], 'test-key');
    assert.equal(seen[0].headers['x-client'], 'octoparse-cli');
    assert.match(seen[0].headers['x-client-version'], /^\d+\.\d+\.\d+/);
    assert.equal(seen[0].headers['x-client-id'], undefined);
    assert.equal(seen[0].headers['x-client-verison'], undefined);

    const validation = await validateApiKey({ apiKey: 'test-key', baseUrl: 'https://example.invalid' });
    assert.equal(validation.endpoint, '/api/account/getAccount');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('remote task not found suggests a nearby listed task id', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTO_ENGINE_API_KEY;
  process.env.OCTO_ENGINE_API_KEY = 'dummy';
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/task/getTask') {
      return new Response(JSON.stringify({ isSuccess: true, data: null }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/task/searchTaskListV3') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          total: 1,
          currentTotal: 1,
          dataList: [{
            taskId: '2dca8f7d-c689-c5dd-a0d4-6aeabf8f73ef',
            taskName: 'Example Developer Blog'
          }]
        }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: false, error: 'unexpected' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    await assert.rejects(
      new TaskDefinitionProvider().getTask('2dca8f7d-c689-c5dd-a0d4-6eaabf8f73ef'),
      (error) => {
        assert.match(error.message, /Did you mean/);
        assert.match(error.message, /6aeabf8f73ef/);
        assert.match(error.message, /octoparse run 2dca8f7d-c689-c5dd-a0d4-6aeabf8f73ef/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OCTO_ENGINE_API_KEY;
    else process.env.OCTO_ENGINE_API_KEY = originalApiKey;
  }
});

test('cloud history enriches lots with exportable unique row counts', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTO_ENGINE_API_KEY;
  const originalLog = console.log;
  process.env.OCTO_ENGINE_API_KEY = 'dummy';
  const lines = [];
  const seen = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    seen.push(parsed.pathname);
    if (parsed.pathname === '/api/progress/task/task-cloud-history') {
      return new Response(JSON.stringify({
        data: [{
          lot: 'lot_1',
          status: 4,
          startTime: '2026-04-15T15:18:44+08:00',
          dataCnt: 14,
          extCnt: 14
        }],
        error: 'success'
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/taskData/task-cloud-history/lot/lot_1/exportData') {
      return new Response(JSON.stringify({
        data: {
          offset: 1,
          total: 12,
          restTotal: 11,
          duplicate: 2,
          files: [{ fileBody: '' }]
        },
        error: 'success'
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ error: 'unexpected' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (line = '') => {
    lines.push(String(line));
  };

  try {
    const code = await cloudHistory(['task-cloud-history', '--api-base-url', 'https://example.invalid']);
    assert.equal(code, 0);
    assert.ok(seen.includes('/api/progress/task/task-cloud-history'));
    assert.ok(seen.includes('/api/taskData/task-cloud-history/lot/lot_1/exportData'));
    assert.match(lines.join('\n'), /rows=14  uniqueRows=12  duplicateRows=2/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) delete process.env.OCTO_ENGINE_API_KEY;
    else process.env.OCTO_ENGINE_API_KEY = originalApiKey;
  }
});

test('runtime proxy requests use OP proxy consumption type', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTO_ENGINE_API_KEY;
  process.env.OCTO_ENGINE_API_KEY = 'dummy';
  let seenUrl;
  globalThis.fetch = async (url) => {
    seenUrl = new URL(String(url));
    return new Response(JSON.stringify({
      data: {
        status: 0,
        ip: '127.0.0.1',
        port: 8080,
        protocol: 1
      },
      error: 'success'
    }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    await resolveProxy({
      taskId: 'proxy-task',
      taskName: 'Proxy Task',
      xml: '',
      xoml: '',
      fieldNames: [],
      brokerSettings: {
        ipProxySettings: {
          ipProxyFromType: 1,
          strongIpProxySettings: { areaId: 88 }
        }
      }
    }, 'lot-1', 'https://example.com/page');
    assert.equal(seenUrl.pathname, '/api/HttpProxy');
    assert.equal(seenUrl.searchParams.get('taskId'), 'proxy-task');
    assert.equal(seenUrl.searchParams.get('LotNo'), 'lot-1');
    assert.equal(seenUrl.searchParams.get('areaId'), '88');
    assert.equal(seenUrl.searchParams.get('consumptionType'), '2');
    assert.equal(seenUrl.searchParams.get('url'), 'https://example.com/page');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OCTO_ENGINE_API_KEY;
    else process.env.OCTO_ENGINE_API_KEY = originalApiKey;
  }
});

test('runtime image captcha uses OP ImageCaptcha payload', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTO_ENGINE_API_KEY;
  process.env.OCTO_ENGINE_API_KEY = 'dummy';
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({
      url: new URL(String(url)),
      headers: init?.headers ?? {},
      body: String(init?.body ?? '')
    });
    return new Response(JSON.stringify({
      data: {
        status: 1,
        captcha: 'decoded-text'
      },
      error: 'success'
    }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const answer = await solveCaptcha(
      { captchaType: 'image', image: 'base64-image' },
      {
        taskId: 'captcha-task',
        taskName: 'Captcha Task',
        xml: '',
        xoml: '',
        fieldNames: []
      },
      'lot-2'
    );
    assert.deepEqual(answer, { token: 'decoded-text' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url.pathname, '/api/Captcha/ImageCaptcha');
    assert.equal(seen[0].headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(seen[0].body), {
      TaskId: 'captcha-task',
      ImageBase64: 'base64-image',
      CaptchaType: 62,
      LotNo: 'lot-2'
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OCTO_ENGINE_API_KEY;
    else process.env.OCTO_ENGINE_API_KEY = originalApiKey;
  }
});

test('root and run help clearly state API key requirement', async () => {
  const root = await runCli(['--help']);
  assert.equal(root.code, 0);
  assert.match(root.stdout, /API key is required for all functional commands/);
  assert.match(root.stdout, /octoparse\.com\/console\/account-center\/api-keys/);

  const auth = await runCli(['auth', '--help']);
  assert.equal(auth.code, 0);
  assert.match(auth.stdout, /Interactive login opens this page automatically/);
  assert.match(auth.stdout, /--no-open/);

  const run = await runCli(['run', '--help']);
  assert.equal(run.code, 0);
  assert.match(run.stdout, /Requires a configured API key/);
  assert.match(run.stdout, /run only starts local extraction/);
  assert.match(run.stdout, /data export <taskId> --lot-id <lotId>/);
});

test('usage failures honor --json envelopes', async () => {
  const run = await runCli(['run', '--json'], { apiKey: 'dummy' });
  const runPayload = assertJsonFailure(run, 'USAGE_ERROR');
  assert.match(runPayload.error.message, /missing taskId/);

  const unknown = await runCli(['nope', '--json']);
  assertJsonFailure(unknown, 'UNKNOWN_COMMAND');
});

test('agent-facing commands expose json envelopes for key contract paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octo-contract-'));
  const output = join(root, 'runs');
  const apiKey = 'dummy';

  const successCases = [
    ['auth', 'status', '--json'],
    ['env', 'status', '--json'],
    ['doctor', '--chrome-path', process.execPath, '--json'],
    ['local', 'cleanup', '--json'],
    ['local', 'status', 'missing-task', '--json'],
    ['local', 'history', 'missing-task', '--output', output, '--json'],
    ['data', 'history', 'missing-task', '--source', 'local', '--output', output, '--json'],
    ['runs', 'list', '--output', output, '--json'],
    ['runs', 'cleanup', '--output', output, '--json']
  ];
  for (const args of successCases) {
    assertJsonSuccess(await runCli(args, { apiKey }), args);
  }

  const failureCases = [
    { args: ['task', 'inspect', '--task-file', 'examples/minimal-task.json', '--json'], code: 'USAGE_ERROR' },
    { args: ['cloud', 'pause', 'task-1', '--json'], code: 'USAGE_ERROR' },
    { args: ['cloud', 'status', '--api-base-url', 'http://127.0.0.1:9', '--json'], code: 'USAGE_ERROR' },
    { args: ['local', 'status', '--json'], code: 'USAGE_ERROR' },
    { args: ['local', 'stop', 'missing-task', '--json'], code: 'LOCAL_RUN_CONTROL_FAILED' },
    { args: ['local', 'export', 'missing-task', '--output', output, '--json'], code: 'LOCAL_LOT_NOT_FOUND' },
    { args: ['data', 'history', '--source', 'cloud', '--json'], code: 'USAGE_ERROR' },
    { args: ['data', 'export', '--source', 'cloud', '--json'], code: 'USAGE_ERROR' },
    { args: ['data', 'export', 'missing-task', '--source', 'local', '--format', 'bad', '--json'], code: 'UNSUPPORTED_EXPORT_FORMAT' },
    { args: ['runs', 'status', '--output', output, '--json'], code: 'USAGE_ERROR' },
    { args: ['runs', 'status', 'missing-run', '--output', output, '--json'], code: 'RUN_NOT_FOUND' },
    { args: ['runs', 'logs', '--output', output, '--limit', '1', '--json'], code: 'USAGE_ERROR' },
    { args: ['runs', 'data', '--output', output, '--limit', '1', '--json'], code: 'USAGE_ERROR' },
    { args: ['run', 'export', 'missing-task', '--json'], code: 'USAGE_ERROR' },
    { args: ['runs', 'export', 'missing-run', '--file', join(root, 'result.csv'), '--format', 'bad', '--json'], code: 'USAGE_ERROR' },
    { args: ['runs', 'export', '--output', output, '--file', join(root, 'result.csv'), '--json'], code: 'USAGE_ERROR' }
  ];
  for (const item of failureCases) {
    assertJsonFailure(await runCli(item.args, { apiKey }), item.code, 1, item.args);
  }
});

test('cleanup commands remove orphaned local control state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octo-cleanup-'));
  const home = join(root, 'home');
  const output = join(root, 'runs');
  const activeDir = join(home, '.octoparse', 'active-local');
  const runDir = join(output, 'run_stale');
  await mkdir(activeDir, { recursive: true });
  await mkdir(runDir, { recursive: true });

  const staleState = {
    runId: 'run_stale',
    lotId: 'lot_stale',
    taskId: 'stale-task',
    pid: 999999,
    socketPath: join(root, 'missing.sock'),
    status: 'running',
    outputDir: output,
    updatedAt: new Date().toISOString()
  };
  const activeFile = join(activeDir, 'stale-task.json');
  const controlFile = join(runDir, 'control.json');
  const metaFile = join(runDir, 'meta.json');
  await writeFile(activeFile, `${JSON.stringify(staleState, null, 2)}\n`);
  await writeFile(controlFile, `${JSON.stringify(staleState, null, 2)}\n`);
  await writeFile(join(runDir, 'rows.jsonl'), '{"a":1}\n{"a":2}\n');

  const localStatus = await runCli(['local', 'status', 'stale-task', '--json'], { apiKey: 'dummy', home });
  const statusPayload = assertJsonSuccess(localStatus);
  assert.equal(statusPayload.data.status, 'not_running');
  assert.equal(statusPayload.data.active, false);
  assert.equal(statusPayload.data.currentRun, null);
  assert.equal(statusPayload.data.cleanedStaleState, true);
  assert.equal(statusPayload.data.lastRun.status, 'stopped');
  assert.equal(statusPayload.data.lastRun.total, 2);
  await assert.rejects(access(controlFile));
  await assert.rejects(access(activeFile));
  const preserved = JSON.parse(await readFile(metaFile, 'utf8'));
  assert.equal(preserved.status, 'stopped');
  assert.equal(preserved.total, 2);

  await writeFile(activeFile, `${JSON.stringify(staleState, null, 2)}\n`);
  await writeFile(controlFile, `${JSON.stringify(staleState, null, 2)}\n`);

  const runsCleanup = await runCli(['runs', 'cleanup', '--output', output, '--json'], { apiKey: 'dummy', home });
  const runsPayload = assertJsonSuccess(runsCleanup);
  assert.equal(runsPayload.data.checked, 1);
  assert.equal(runsPayload.data.removed, 1);
  await assert.rejects(access(controlFile));
  await assert.rejects(access(activeFile));

  await writeFile(activeFile, `${JSON.stringify(staleState, null, 2)}\n`);
  const localCleanup = await runCli(['local', 'cleanup', '--json'], { apiKey: 'dummy', home });
  const localPayload = assertJsonSuccess(localCleanup);
  assert.equal(localPayload.data.checked, 1);
  assert.equal(localPayload.data.removed, 1);
  await assert.rejects(access(activeFile));
});

test('local status reports idle with last run summary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octo-local-status-last-'));
  const output = join(root, 'runs');
  const runDir = join(output, 'run_status_last_20260429010101');
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'meta.json'), `${JSON.stringify({
    runId: 'run_status_last_20260429010101',
    lotId: 'lot_20260429010101',
    taskId: 'status-last-task',
    taskName: 'Status Last Task',
    status: 'stopped',
    total: 2,
    outputDir: runDir,
    startedAt: '2026-04-29T01:01:01.000Z',
    stoppedAt: '2026-04-29T01:02:01.000Z'
  }, null, 2)}\n`);

  const jsonResult = await runCli([
    'local',
    'status',
    'status-last-task',
    '--output',
    output,
    '--json'
  ], { apiKey: 'dummy' });
  const payload = assertJsonSuccess(jsonResult);
  assert.equal(payload.data.status, 'not_running');
  assert.equal(payload.data.active, false);
  assert.equal(payload.data.currentRun, null);
  assert.equal(payload.data.lastRun.status, 'stopped');
  assert.equal(payload.data.lastRun.lotId, 'lot_20260429010101');

  const humanResult = await runCli([
    'local',
    'status',
    'status-last-task',
    '--output',
    output
  ], { apiKey: 'dummy' });
  assert.equal(humanResult.code, 0, formatCliResult(humanResult));
  assert.match(humanResult.stdout, /status-last-task  idle/);
  assert.match(humanResult.stdout, /Last run: stopped  rows=2  lot=lot_20260429010101/);
});

test('local history reports row count from rows artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octo-history-rows-'));
  const output = join(root, 'runs');
  const runDir = join(output, 'run_task_rows_20260429010101');
  const staleRunDir = join(output, 'run_task_rows_20260429010202');
  await mkdir(runDir, { recursive: true });
  await mkdir(staleRunDir, { recursive: true });
  await writeFile(join(runDir, 'meta.json'), `${JSON.stringify({
    runId: 'run_task_rows_20260429010101',
    lotId: 'lot_20260429010101',
    taskId: 'task-rows',
    taskName: 'Rows Task',
    status: 'stopped',
    total: 0,
    outputDir: runDir,
    startedAt: '2026-04-29T01:01:01.000Z',
    stoppedAt: '2026-04-29T01:02:01.000Z'
  }, null, 2)}\n`);
  await writeFile(join(runDir, 'rows.jsonl'), '{"a":1}\n{"a":2}\n');
  await writeFile(join(staleRunDir, 'control.json'), `${JSON.stringify({
    runId: 'run_task_rows_20260429010202',
    lotId: 'lot_20260429010202',
    taskId: 'task-rows',
    pid: 999999,
    socketPath: join(root, 'missing.sock'),
    status: 'running',
    outputDir: output,
    updatedAt: '2026-04-29T01:02:02.000Z'
  }, null, 2)}\n`);
  await writeFile(join(staleRunDir, 'rows.jsonl'), '{"a":3}\n{"a":4}\n{"a":5}\n');

  const result = await runCli(['data', 'history', 'task-rows', '--source', 'local', '--output', output, '--json'], { apiKey: 'dummy' });
  const payload = assertJsonSuccess(result);
  assert.equal(payload.data.length, 2);
  assert.equal(payload.data[0].lotId, 'lot_20260429010202');
  assert.equal(payload.data[0].status, 'stopped');
  assert.equal(payload.data[0].total, 3);
  assert.equal(payload.data[1].total, 2);
});

test('minimal example validates with API key', async () => {
  const result = await runCli([
    'task',
    'validate',
    'minimal',
    '--task-file',
    'examples/minimal-task.json',
    '--json'
  ], { apiKey: 'dummy' });
  assert.equal(result.code, 0);
  const payload = parseJson(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.actionCount, 1);
  assert.deepEqual(payload.data.actionTypes, ['NavigateAction']);
});

test('run rejects --format and points users to data export', async () => {
  const result = await runCli(['run', 'minimal', '--format', 'csv', '--json'], { apiKey: 'dummy' });
  assert.equal(result.code, 1);
  const payload = parseJson(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'RUN_FORMAT_UNSUPPORTED');
  assert.match(payload.error.message, /data export --format/);

  const jsonl = await runCli(['run', 'minimal', '--format', 'csv', '--jsonl'], { apiKey: 'dummy' });
  assert.equal(jsonl.code, 1);
  assert.equal(jsonl.stdout.trim().split('\n').length, 1);
  const jsonlPayload = parseJson(jsonl.stdout);
  assert.equal(jsonlPayload.ok, false);
  assert.equal(jsonlPayload.error.code, 'RUN_FORMAT_UNSUPPORTED');
});

test('run validates max rows as a positive integer', async () => {
  const result = await runCli(['run', 'minimal', '--max-rows', '0', '--json'], { apiKey: 'dummy' });
  assertJsonFailure(result, 'RUN_MAX_ROWS_INVALID');
  assert.match(parseJson(result.stdout).error.message, /--max-rows/);
});

test('run completion prints a copyable local data export command', () => {
  assert.equal(
    localDataExportCommand({ taskId: 'task-1', lotId: '1778123456789' }),
    'octoparse data export task-1 --source local --lot-id 1778123456789'
  );
});

test('task list text output hides internal workflow metadata', () => {
  const line = formatTaskListLine({
    taskId: 'task-1',
    taskName: 'Demo Task',
    status: 1,
    workflowType: 1,
    workFlowType: 1
  });
  assert.equal(line, '  task-1  Demo Task');
  assert.doesNotMatch(line, /workflow=/);
  assert.doesNotMatch(line, /status=/);
});

test('detached startup failure writes bootstrap artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octo-detach-'));
  const home = join(root, 'home');
  const output = join(root, 'runs');
  const taskFile = join(root, 'invalid-task.json');
  await writeFile(taskFile, JSON.stringify({
    taskId: 'invalid-detach',
    taskName: 'Invalid Detach',
    xml: '<Root />',
    xoml: '<?xml version="1.0"?><definitions><process id="p" isExecutable="true" /></definitions>',
    fieldNames: []
  }));

  const result = await runCli([
    'run',
    'invalid-detach',
    '--task-file',
    taskFile,
    '--output',
    output,
    '--detach',
    '--json'
  ], { apiKey: 'dummy', apiBaseUrl: 'http://127.0.0.1:9', home, timeout: 20_000 });

  assert.equal(result.code, 2, formatCliResult(result, [
    'run',
    'invalid-detach',
    '--task-file',
    taskFile,
    '--output',
    output,
    '--detach',
    '--json'
  ]));
  const payload = parseJson(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'DETACHED_RUN_FAILED');

  const bootstrapDir = payload.error.message.match(/bootstrap=(.+)$/)?.[1];
  assert.ok(bootstrapDir, payload.error.message);
  const bootstrap = JSON.parse(await readFile(join(bootstrapDir, 'bootstrap.json'), 'utf8'));
  assert.equal(bootstrap.status, 'failed');
  assert.match(bootstrap.error, /actionType|Nothing to execute|executable/);
  assert.equal(bootstrap.taskId, 'invalid-detach');
});
