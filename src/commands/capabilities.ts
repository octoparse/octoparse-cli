import { homedir } from 'node:os';
import { join } from 'node:path';
import { printEnvelope } from '../cli/output.js';
import { API_BASE_URL_ENV } from '../runtime/api-client.js';
import { ACCESS_TOKEN_ENV, API_KEY_ENV } from '../runtime/auth.js';
import { LINUX_ARM64_UNSUPPORTED_CODE, localChromePlatformNote, supportedLocalChromePlatforms, unsupportedLocalChromePlatforms } from '../runtime/platform-support.js';
import { EXIT_OK } from '../types.js';

export async function capabilitiesCommand(version: string, json: boolean): Promise<number> {
  const data = {
    name: 'octoparse',
    packageName: '@octoparse-cli/octoparse-cli',
    primaryBinary: 'octoparse',
    invocation: {
      installed: 'octoparse',
      npmExec: 'npx @octoparse-cli/octoparse-cli',
      note: '@octoparse-cli/octoparse-cli is the npm package name; octoparse is the CLI binary exposed by the package.'
    },
    version,
    agentContractVersion: 1,
    authentication: {
      requiredForUse: true,
      methods: ['oauth', 'apiKey'],
      loginVerifiesKeyBeforeSaving: true,
      loginSupportsOAuthBrowserFlow: true,
      setupCommandsWithoutAuth: ['auth login', 'auth status', 'auth info', 'auth logout', 'env status', 'env prod', 'env online'],
      diagnosticCommandsWithoutAuth: ['--help', '--version', 'capabilities', 'doctor', 'browser doctor'],
      env: API_KEY_ENV,
      accessTokenEnv: ACCESS_TOKEN_ENV,
      file: join(homedir(), '.octoparse', 'credentials.json')
    },
    output: {
      jsonEnvelope: { success: { ok: true, data: {} }, failure: { ok: false, error: { code: 'ERROR_CODE', message: 'message' } } },
      jsonlEvents: ['warning', 'billing.warning', 'billing.error', 'run.started', 'row', 'log', 'captcha', 'proxy', 'download.started', 'download.succeeded', 'download.failed', 'run.paused', 'run.resumed', 'run.stopping', 'run.stopped', 'run.failed'],
      detachedBootstrap: ['bootstrap.json', 'stdout.log', 'stderr.log'],
      stdout: 'machine data only in --json/--jsonl mode',
      stderr: 'human diagnostics and failures'
    },
    browserRuntime: {
      browser: 'Chrome for Testing',
      localExecutionRequiresBrowser: true,
      supportedPlatforms: supportedLocalChromePlatforms(),
      unsupportedPlatforms: unsupportedLocalChromePlatforms(),
      linuxArm64: {
        supported: false,
        reason: localChromePlatformNote(),
        errorCode: LINUX_ARM64_UNSUPPORTED_CODE,
        affectedCommands: ['doctor without --chrome-path', 'browser doctor without --chrome-path', 'detect', 'run']
      }
    },
    machineContract: {
      stable: true,
      defaultOutput: 'human',
      agentEntrypoint: {
        firstCommand: 'octoparse capabilities --json',
        packageFirstCommand: 'npx @octoparse-cli/octoparse-cli capabilities --json',
        rule: 'When a user asks an LLM/agent to use octoparse or @octoparse-cli/octoparse-cli for a scraping task, inspect this capabilities payload first and follow machineContract.recipes instead of asking the user to describe CLI flags.',
        agentInvocationPolicy: {
          shouldUseCliForUserTaskCreationRequests: true,
          preferredRecipe: 'machineContract.recipes.createTaskFromUrlWithAgent',
          doNotFallbackToHandwrittenTaskJson: true,
          doNotAskUserForInternalFlags: true,
          routingRule: 'If the user asks an LLM/agent to create, build, generate, or validate a scraping/extraction task from a URL using octoparse, call capabilities --json, then run the preferred recipe. Use manual detect only when the user explicitly asks to choose elements themselves or when login/verification requires user action.'
        },
        intentAliases: [
          'create scraping task from url',
          'generate extraction task',
          'build octoparse task',
          'use octoparse CLI to create a task',
          'let an Agent/LLM use octoparse to generate a task'
        ],
        acceptedUserRequestExamples: [
          'Use octoparse to create a scraping task for <url>',
          'Create and validate a local task file from this page with @octoparse-cli/octoparse-cli: <url>',
          'Generate an Octoparse task for search results on <url>'
        ]
      },
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
          'TEMPLATE_BALANCE_NOT_ENOUGH',
          'TEMPLATE_NOT_ALLOWED',
          'PROXY_BALANCE_LOW',
          'CAPTCHA_BALANCE_LOW',
          'CAPTCHA_ACCOUNT_EXPIRED',
          'CAPTCHA_BALANCE_NOT_ENOUGH',
          'CAPTCHA_DAILY_LIMIT_REACHED',
          'CAPTCHA_SERVICE_ERROR',
          'CAPTCHA_SERVICE_FAILED',
          'PROXY_BALANCE_NOT_ENOUGH',
          'PROXY_USER_NOT_ALLOWED',
          'PROXY_LIMIT_REACHED',
          'PROXY_SERVICE_UNAVAILABLE',
          'PROXY_SERVICE_FAILED',
          'RUN_FORMAT_UNSUPPORTED',
          'DETACHED_RUN_FAILED',
          'ENGINE_RUN_FAILED',
          'LOCAL_RUN_ALREADY_RUNNING',
          'LOCAL_RUN_CONTROL_FAILED',
          'RUN_CONTROL_FAILED',
          'LOGIN_SESSION_REQUIRED',
          'DETECT_FAILED',
          'DETECT_SELECT_REQUIRED',
          'DETECT_OUTPUT_REQUIRED',
          'DETECT_CANDIDATE_NOT_FOUND',
          'DETECT_CANDIDATE_UNSUPPORTED',
          LINUX_ARM64_UNSUPPORTED_CODE,
          'CHROME_LAUNCH_FAILED',
          'RUN_NOT_FOUND',
          'LOCAL_LOT_NOT_FOUND',
          'UNSUPPORTED_EXPORT_FORMAT'
        ]
      },
      jsonl: {
        flag: '--jsonl',
        command: 'run <taskId>',
        eventField: 'event',
        stableEvents: ['warning', 'billing.warning', 'billing.error', 'run.started', 'row', 'log', 'captcha', 'proxy', 'download.started', 'download.succeeded', 'download.failed', 'run.paused', 'run.resumed', 'run.stopping', 'run.stopped', 'run.failed'],
        rowLimitFlag: '--max-rows'
      },
      artifacts: {
        localRunDir: ['meta.json', 'control.json', 'events.jsonl', 'logs.jsonl', 'rows.jsonl', 'downloads.jsonl'],
        detachedBootstrapDir: ['bootstrap.json', 'stdout.log', 'stderr.log']
      },
      lifecycle: {
        detachModel: 'child-process',
        daemonRequired: false,
        activeRunIdentity: 'taskId',
        artifactRunIdentity: 'runId',
        accountLocalRunLimit: false,
        localRunResourceWarning: {
          code: 'LOCAL_RUN_RESOURCE_WARNING',
          threshold: 4,
          strongThreshold: 6,
          blocking: false
        },
        maxActiveLocalRunsPerTaskId: 1,
        orphanDetection: true,
        cleanupCommands: ['local cleanup', 'runs cleanup']
      },
      recipes: {
        createTaskFromUrlWithAgent: {
          intent: 'When the user asks an LLM/agent to create a scraping or extraction task from a URL with octoparse, use this workflow unless the user explicitly asks for manual selection.',
          summary: 'Use protected SmartProxy detection to emit deterministic candidates, write an agent plan, preview it, apply it, then validate the task.',
          agentShouldChooseThisRecipeWhen: [
            'The user asks the assistant/agent to create, build, generate, or validate a task from a URL.',
            'The user mentions octoparse, Octoparse CLI, scraping task, extraction task, or local task file.',
            'The user provides a URL plus a target goal such as search results, list data, detail pages, titles, prices, articles, or links.'
          ],
          searchWorkflow: {
            trigger: 'If the user asks to search/query/find a keyword on an entry page, pass --query <keyword> or --input <name=value> to detect before preparing/applying a task.',
            examples: [
              'octoparse detect https://www.google.com/ --auto --query "Bruce Lee" --output task.json',
              'octoparse detect https://www.google.com/ --prepare-agent --query "Bruce Lee" --json --goal "Search Bruce Lee and extract result titles and links" --output context.json'
            ],
            taskBehavior: 'Generated tasks preserve the detected search input XPath and submit action before extracting the result page.'
          },
          loginWorkflow: {
            trigger: 'If detect returns LOGIN_SESSION_REQUIRED or detects a login/captcha/paywall page, ask the user to run manual detect, complete login in the browser, and save a session.',
            command: 'octoparse detect <url> --manual --query <keyword> --save-session --session-name <name> --output <task.json>',
            note: 'The generated task stores both detection.session and detection.search so local runs inject cookies before opening the search entry page.'
          },
          agentResponsibilities: [
            'Do not ask the user to explain --prepare-agent, --preview-agent-plan, or --apply-agent-plan.',
            'Do not ask the user to hand-write JSON. The agent writes plan.json after reading context.json.',
            'Pass the user natural-language task description through --goal so context.goal captures the real intent.',
            'Use context.decisionPolicy and context.screenshot.path as mandatory judging inputs for candidates, layout, sidebars, ads, and pagination.',
            'Use context.resultValidationPolicy after running data: isolated missing fields in ads/topic cards/heterogeneous rows are normal partial data and must not trigger task recreation loops.',
            'If the user intent includes search/query/keyword, extract the keyword and pass it through --query or --input instead of detecting the blank search homepage.',
            'Use the URL and optional user goal as the task intent, then inspect candidates and sample rows before choosing fields.',
            'Show the user the generated task file path and validation result after applying the plan.'
          ],
          preferredWorkflow: [
            {
              step: 'detect',
              command: 'octoparse detect <url> --prepare-agent --json --goal <user task description> --output <context.json>',
              output: 'agent context JSON containing recommendedCandidateId, decisionPolicy, resultValidationPolicy, candidates, fields, sampleRows, XPath, diagnostics, pagination, goal, and full-page screenshot metadata. A full-page screenshot is generated by default for agent workflows.'
            },
            {
              step: 'writePlan',
              action: 'Read context.json, choose the primary candidate, select/rename fields, and write plan.json using schema octopus.detect.agent-plan.v1.',
              guidance: [
                'Follow context.decisionPolicy: use context.goal and context.screenshot.path together with candidate bounding boxes, sampleRows, fields, pagination, and diagnostics; do not rely on text samples alone.',
                'Prefer context.recommendedCandidateId unless diagnostics/sampleRows show it is sidebar, navigation, ads, or wrong for the user goal.',
                'Use existing field names through strings or { "source": "<field>", "as": "<newName>" }; do not invent XPath when an existing field works.',
                'If using details, set selection.detail.mode=list_with_detail, urlField, and detail.fields.',
                'Set selection.pagination to the candidate pagination, null/false to disable pagination, or omit to keep the candidate default.'
              ],
              minimalPlan: {
                schemaVersion: 'octopus.detect.agent-plan.v1',
                contextFile: '<context.json>',
                selection: {
                  candidateId: '<candidate id>',
                  fields: ['<field name>', { source: '<field name>', as: '<new name>' }],
                  pagination: null
                }
              }
            },
            {
              step: 'preview',
              command: 'octoparse detect --preview-agent-plan <plan.json> --agent-context <context.json> --json',
              requiredAction: 'If ok=false or data.pass=false, revise plan fields before applying unless the user explicitly accepts risk.'
            },
            {
              step: 'apply',
              command: 'octoparse detect --apply-agent-plan <plan.json> --agent-context <context.json> --output <task.json> --json',
              output: 'task JSON file'
            },
            {
              step: 'validate',
              command: 'octoparse task validate <taskId> --task-file <task.json> --json',
              postRunJudgment: [
                'After running sample data, follow context.resultValidationPolicy before deciding whether to revise the task.',
                'Do not recreate a task just because one row or a small minority of rows has missing optional fields.',
                'Treat sparse ad/topic/promoted/heterogeneous cards as normal partial data when the main list rows match the user goal.',
                'Automatically recreate at most once, and only for systematic structural failures such as wrong region, wrong search result page, wrong pagination, or core fields missing for most representative rows.'
              ]
            }
          ],
          oneShotWrapper: {
            command: 'octoparse detect <url> --agent --agent-command <cmd> --output <task.json>',
            note: 'Use this only when a trusted agent runner command is available. --agent-command executes a local shell command. The runner receives OCTOPARSE_AGENT_CONTEXT and must write OCTOPARSE_AGENT_PLAN.'
          },
          nonGoals: [
            'Do not ask the user to hand-write plan.json.',
            'Do not directly write full task JSON unless applying a previewed plan through the CLI.',
            'Do not use --legacy-detector unless debugging the old heuristic detector.'
          ]
        }
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
      { command: 'auth login/status/info/logout', risk: 'medium', json: true, authRequired: false },
      { command: 'env prod/online/status', risk: 'medium', json: true, hidden: true, authRequired: false },
      { command: 'task list', risk: 'low', json: true, authRequired: true },
      { command: 'task inspect/validate', risk: 'low', json: true, authRequired: true },
      { command: 'detect <url>', risk: 'medium', json: true, authRequired: true, agentWorkflow: 'machineContract.recipes.createTaskFromUrlWithAgent' },
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
      accessToken: ACCESS_TOKEN_ENV,
      apiBaseUrl: API_BASE_URL_ENV
    }
  };

  if (json) printEnvelope(true, data);
  else console.log(JSON.stringify(data, null, 2));
  return EXIT_OK;
}
