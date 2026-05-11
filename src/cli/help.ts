import { API_BASE_URL_ENV } from '../runtime/api-client.js';
import { API_KEY_ENV } from '../runtime/auth.js';
import { API_KEYS_URL } from '../commands/auth.js';

export function printCommandHelp(command: string, subcommand?: string): void {
  const key = subcommand && !subcommand.startsWith('-') ? `${command} ${subcommand}` : command;
  const help: Record<string, string> = {
    capabilities: `Usage:
  octoparse capabilities [--json]

Purpose:
  Print machine-readable CLI capabilities for agents.

Authentication:
  Does not require an API key. Functional commands do.
`,
  auth: `Usage:
  octoparse auth login <apiKey> [--api-base-url <url>] [--json]
  octoparse auth login [--stdin] [--no-open] [--api-base-url <url>] [--json]
  octoparse auth status [--json]
  octoparse auth logout [--json]

API key:
  Create one at ${API_KEYS_URL}
  Interactive login opens this page automatically, then verifies and stores the key.
  If the browser does not open, copy the URL above and open it manually.

Agent notes:
  Use "auth login <apiKey>" to verify and save a copied key directly.
  Use "auth login --stdin" for non-interactive setup.
  login verifies the API key before saving; invalid keys are not stored.
  ${API_KEY_ENV} overrides stored credentials.
  Functional commands require a configured API key, including local task-file and OTD runs.
`,
    env: `Usage:
  octoparse env pre [--json]
  octoparse env prod [--json]
  octoparse env status [--json]

Purpose:
  Hidden internal command for switching API environment.
`,
    task: `Usage:
  octoparse task list [--page <n>] [--page-size <n>] [--keyword <text>] [--json]
  octoparse task inspect <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
  octoparse task validate <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
`,
    'task list': `Usage:
  octoparse task list [--page <n>] [--page-size <n>] [--keyword <text>] [--json]
`,
    'task inspect': `Usage:
  octoparse task inspect <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
`,
    'task validate': `Usage:
  octoparse task validate <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
`,
    run: `Usage:
  octoparse run <taskId> [--task-file <file.json|file.xml|file.otd>] [--output <dir>] [--chrome-path <path>] [--headless] [--max-rows <n>] [--detach] [--json|--jsonl]

Agent notes:
  Requires a configured API key even when --task-file points to a local JSON, XML, or OTD file.
  Use --detach for background local extraction.
  Use --max-rows <n> to stop automatically after saving n rows.
  Use --jsonl for foreground event streams.
  JSONL now includes captcha and proxy request events when the runtime asks for them.
  run only starts local extraction. Use data export <taskId> --lot-id <lotId> for files.
`,
    cloud: `Usage:
  octoparse cloud start <taskId> [--json]
  octoparse cloud stop <taskId> [--json]
  octoparse cloud status <taskId> [--json]
  octoparse cloud history <taskId> [--json]

Notes:
  Cloud extraction only supports start/stop. There is no cloud pause/resume.
`,
    local: `Usage:
  octoparse local status <taskId> [--output <dir>] [--json]
  octoparse local pause <taskId> [--json]
  octoparse local resume <taskId> [--json]
  octoparse local stop <taskId> [--json]
  octoparse local history <taskId> [--output <dir>] [--json]
  octoparse local export <taskId> [--file <result.xlsx>] [--lot-id <lotId>] [--output <dir>] [--format xlsx|csv|html|json|xml] [--json]
  octoparse local cleanup [--json]
`,
    data: `Usage:
  octoparse data history <taskId> [--source local|cloud|--local|--cloud] [--output <dir>] [--json]
  octoparse data export <taskId> [--source local|cloud|--local|--cloud] [--file <result.xlsx>] [--lot-id <lotId>] [--output <dir>] [--format xlsx|csv|html|json|xml] [--json]

Defaults:
  --source local
  --format xlsx, unless inferred from --file extension
  --file task-name.<format>, with Windows-style duplicate suffixes
`,
    'data history': `Usage:
  octoparse data history <taskId> [--source local|cloud|--local|--cloud] [--output <dir>] [--json]
`,
    'data export': `Usage:
  octoparse data export <taskId> [--source local|cloud|--local|--cloud] [--file <result.xlsx>] [--lot-id <lotId>] [--output <dir>] [--format xlsx|csv|html|json|xml] [--json]
`,
    runs: `Usage:
  octoparse runs list [--output <dir>] [--json]
  octoparse runs status <runId> [--output <dir>] [--json]
  octoparse runs logs <runId> [--output <dir>] [--limit 100] [--json]
  octoparse runs data <runId> [--output <dir>] [--limit 100] [--json]
  octoparse runs cleanup [--output <dir>] [--json]

Purpose:
  Internal local artifact inspection. User workflows should use taskId/lotId commands:
  octoparse data history <taskId> --source local
  octoparse data export <taskId> --source local --lot-id <lotId>
  cleanup removes stale control files whose local control socket is gone.
`,
    doctor: `Usage:
  octoparse doctor [--chrome-path <path>] [--json]
`,
    browser: `Usage:
  octoparse browser doctor [--chrome-path <path>] [--json]
`
  };

  console.log(help[key] ?? help[command] ?? 'Use octoparse --help to view available commands');
}

export function printRootHelp(version: string): void {
  console.log(`octoparse ${version}

Standalone Octoparse engine CLI.

Usage:
  octoparse capabilities [--json]
  octoparse doctor [--chrome-path <path>] [--json]
  octoparse auth login <apiKey> [--api-base-url <url>] [--json]
  octoparse auth login [--stdin] [--no-open] [--api-base-url <url>] [--json]
  octoparse auth status [--json]
  octoparse auth logout [--json]
  octoparse browser doctor [--chrome-path <path>] [--json]
  octoparse task list [--page <n>] [--page-size <n>] [--keyword <text>] [--json]
  octoparse task inspect <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
  octoparse task validate <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
  octoparse run <taskId> [--task-file <file.json|file.xml|file.otd>] [--output <dir>] [--chrome-path <path>] [--headless] [--max-rows <n>] [--detach] [--json|--jsonl]
  octoparse cloud start <taskId> [--json]
  octoparse cloud stop <taskId> [--json]
  octoparse cloud status <taskId> [--json]
  octoparse cloud history <taskId> [--json]
  octoparse local status <taskId> [--output <dir>] [--json]
  octoparse local pause <taskId> [--json]
  octoparse local resume <taskId> [--json]
  octoparse local stop <taskId> [--json]
  octoparse local history <taskId> [--output <dir>] [--json]
  octoparse local export <taskId> [--file <result.xlsx>] [--lot-id <lotId>] [--output <dir>] [--format xlsx|csv|html|json|xml] [--json]
  octoparse local cleanup [--json]
  octoparse data history <taskId> [--source local|cloud|--local|--cloud] [--output <dir>] [--json]
  octoparse data export <taskId> [--source local|cloud|--local|--cloud] [--file <result.xlsx>] [--lot-id <lotId>] [--output <dir>] [--format xlsx|csv|html|json|xml] [--json]

Task file format:
  {
    "taskId": "abc123",
    "taskName": "Example",
    "xml": "... original OTD XML ...",
    "xoml": "... transformed BPMN XOML ...",
    "fieldNames": ["title", "url"],
    "workflowSetting": {},
    "brokerSettings": {},
    "userAgent": "Mozilla/5.0 ...",
    "disableAD": false
  }

Design:
  - Runs embedded @octopus/engine directly.
  - Uses independent Chrome only.
  - Does not require the Electron client.
  - Cloud extraction is controlled through backend APIs; local extraction is controlled by the local engine.
  - Does not support kernel browser or legacy workflow in v1.

Authentication:
  API key is required for all functional commands, including local --task-file and .otd runs.
  Only setup/diagnostic commands can run without it: --help, --version, capabilities, doctor, browser doctor, auth, env.
  API key page:                   ${API_KEYS_URL}
  octoparse auth login <key>     verify and store a copied API key directly
  octoparse auth login          open API key page, verify pasted key, then store it
  octoparse auth login --stdin  read API key from stdin, verify it, then store it
  octoparse auth login --no-open do not open the browser during interactive login
  ${API_KEY_ENV}                  overrides stored credentials
  ${API_BASE_URL_ENV}             overrides API base URL; default is the production API

Run diagnostics:
  --timeout-ms <ms>            overall foreground run timeout, default 600000
  --extension-timeout-ms <ms>  runtime extension registration timeout, default 15000
  --max-rows <n>               stop local extraction after saving n rows
  --debug-bridge              include extension bridge command/response logs

Agent contract:
  --json   return one stable JSON envelope: {"ok":true,"data":...} or {"ok":false,"error":...}
  --jsonl  stream long-running run events as one JSON object per line
  stdout   reserved for requested data/output; diagnostics and failures go to stderr in human mode
  exit 0   success; non-zero means the command did not complete as requested

Exit codes:
  0  success
  1  operation failed
  2  runtime/environment failure
  3  unsupported task definition
`);
}
