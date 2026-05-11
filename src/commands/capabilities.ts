import { homedir } from 'node:os';
import { join } from 'node:path';
import { printEnvelope } from '../cli/output.js';
import { API_BASE_URL_ENV } from '../runtime/api-client.js';
import { API_KEY_ENV } from '../runtime/auth.js';
import { EXIT_OK } from '../types.js';

export async function capabilitiesCommand(version: string, json: boolean): Promise<number> {
  const data = {
    name: 'octoparse',
    version,
    agentContractVersion: 1,
    authentication: {
      requiredForUse: true,
      loginVerifiesKeyBeforeSaving: true,
      setupCommandsWithoutAuth: ['auth login', 'auth status', 'auth logout', 'env status', 'env pre', 'env prod', 'env online'],
      diagnosticCommandsWithoutAuth: ['--help', '--version', 'capabilities', 'doctor', 'browser doctor'],
      env: API_KEY_ENV,
      file: join(homedir(), '.octoparse', 'credentials.json')
    },
    output: {
      jsonEnvelope: { success: { ok: true, data: {} }, failure: { ok: false, error: { code: 'ERROR_CODE', message: 'message' } } },
      jsonlEvents: ['run.started', 'row', 'log', 'run.paused', 'run.resumed', 'run.stopping', 'run.stopped'],
      detachedBootstrap: ['bootstrap.json', 'stdout.log', 'stderr.log'],
      stdout: 'machine data only in --json/--jsonl mode',
      stderr: 'human diagnostics and failures'
    },
    machineContract: {
      stable: true,
      defaultOutput: 'human',
      schemas: {
        capabilities: 'schemas/capabilities-v1.schema.json',
        jsonEnvelope: 'schemas/json-envelope-v1.schema.json',
        runEvent: 'schemas/run-event-v1.schema.json',
        detachedBootstrap: 'schemas/detached-bootstrap-v1.schema.json'
      },
      json: {
        flag: '--json',
        envelope: {
          successRequiredFields: ['ok', 'data'],
          failureRequiredFields: ['ok', 'error.code', 'error.message']
        },
        usageErrorsUseEnvelope: true,
        commonErrorCodes: [
          'AUTH_REQUIRED',
          'AUTH_INVALID',
          'USAGE_ERROR',
          'UNKNOWN_COMMAND',
          'TASK_INVALID',
          'RUN_FORMAT_UNSUPPORTED',
          'DETACHED_RUN_FAILED',
          'ENGINE_RUN_FAILED',
          'LOCAL_RUN_ALREADY_RUNNING',
          'LOCAL_RUN_LIMIT_EXCEEDED',
          'LOCAL_RUN_CONTROL_FAILED',
          'RUN_CONTROL_FAILED',
          'RUN_NOT_FOUND',
          'LOCAL_LOT_NOT_FOUND',
          'UNSUPPORTED_EXPORT_FORMAT'
        ]
      },
      jsonl: {
        flag: '--jsonl',
        command: 'run <taskId>',
        eventField: 'event',
        stableEvents: ['run.started', 'row', 'log', 'run.paused', 'run.resumed', 'run.stopping', 'run.stopped'],
        rowLimitFlag: '--max-rows'
      },
      artifacts: {
        localRunDir: ['meta.json', 'control.json', 'events.jsonl', 'logs.jsonl', 'rows.jsonl'],
        detachedBootstrapDir: ['bootstrap.json', 'stdout.log', 'stderr.log']
      },
      lifecycle: {
        detachModel: 'child-process',
        daemonRequired: false,
        activeRunIdentity: 'taskId',
        artifactRunIdentity: 'runId',
        maxActiveLocalRunsPerTaskId: 1,
        orphanDetection: true,
        cleanupCommands: ['local cleanup', 'runs cleanup']
      }
    },
    exitCodes: {
      0: 'success',
      1: 'operation failed',
      2: 'runtime/environment failure',
      3: 'unsupported task definition'
    },
    commands: [
      { command: 'doctor', risk: 'low', json: true, authRequired: false },
      { command: 'auth login/status/logout', risk: 'medium', json: true, authRequired: false },
      { command: 'env pre/prod/online/status', risk: 'medium', json: true, hidden: true, authRequired: false },
      { command: 'task list', risk: 'low', json: true, authRequired: true },
      { command: 'task inspect/validate', risk: 'low', json: true, authRequired: true },
      { command: 'run <taskId>', risk: 'medium', json: true, jsonl: true, authRequired: true },
      { command: 'cloud start/stop <taskId>', risk: 'medium', json: true, authRequired: true },
      { command: 'cloud status/history <taskId>', risk: 'low', json: true, authRequired: true },
      { command: 'local status/history <taskId>', risk: 'low', json: true, authRequired: true },
      { command: 'local cleanup', risk: 'low', json: true, authRequired: true },
      { command: 'local export <taskId>', risk: 'medium', json: true, authRequired: true },
      { command: 'local pause/resume/stop <taskId>', risk: 'medium', json: true, authRequired: true },
      { command: 'data history <taskId>', risk: 'low', json: true, authRequired: true },
      { command: 'data export <taskId>', risk: 'medium', json: true, authRequired: true },
      { command: 'runs list/status/logs/data', risk: 'low', json: true, internal: true, authRequired: true },
      { command: 'runs cleanup', risk: 'low', json: true, internal: true, authRequired: true }
    ],
    dataSources: ['local', 'cloud'],
    exportFormats: ['xlsx', 'csv', 'html', 'json', 'xml'],
    env: {
      apiKey: API_KEY_ENV,
      apiBaseUrl: API_BASE_URL_ENV
    }
  };

  if (json) printEnvelope(true, data);
  else console.log(JSON.stringify(data, null, 2));
  return EXIT_OK;
}
