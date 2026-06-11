import { API_BASE_URL_ENV } from '../runtime/api-client.js';
import { ACCESS_TOKEN_ENV, API_KEY_ENV } from '../runtime/auth.js';
import { API_KEYS_URL } from '../commands/auth.js';

export function printCommandHelp(command: string, subcommand?: string): void {
  const key = subcommand && !subcommand.startsWith('-') ? `${command} ${subcommand}` : command;
  const help: Record<string, string> = {
    capabilities: `Usage:
  octoparse capabilities [--json]

Purpose:
  Print machine-readable CLI capabilities for agents.
  Agents should call this before planning multi-step workflows such as creating
  a scraping task from a URL. The response includes machineContract.recipes with
  the recommended detect/plan/preview/apply/validate sequence.
  For user requests like "use octoparse to create a task for this URL",
  LLM/agent tools should choose machineContract.recipes.createTaskFromUrlWithAgent
  and run the CLI workflow themselves.
  Agent task creation context includes the user goal and a full-page screenshot
  by default.
  @octoparse-cli/octoparse-cli is the npm package name; octoparse is the installed binary.
  If a user says "use octoparse to create a task for this URL", agents should
  inspect this command and then execute the recipe without asking the user to
  explain internal detect flags.

Authentication:
  Does not require login. Functional commands do.
`,
  auth: `Usage:
  octoparse auth login [--oauth] [--no-open] [--json]
  octoparse auth login --api-key <apiKey> [--api-base-url <url>] [--json]
  octoparse auth login <apiKey> [--api-base-url <url>] [--json]
  octoparse auth login [--stdin] [--no-open] [--api-base-url <url>] [--json]
  octoparse auth status [--json]
  octoparse auth info [--json]
  octoparse auth logout [--json]

Login methods:
  Interactive login lets you choose OAuth or API key.
  OAuth opens the browser and stores an access/refresh token locally.
  Create one at ${API_KEYS_URL}
  API key login opens this page automatically, then verifies and stores the key.
  If the browser does not open, copy the URL above and open it manually.

Agent notes:
  Use "auth login --oauth" to force browser-based OAuth.
  Use "auth login <apiKey>" to verify and save a copied key directly.
  Use "auth login --stdin" for non-interactive setup.
  login verifies the API key before saving; invalid keys are not stored.
  ${API_KEY_ENV} overrides stored credentials.
  ${ACCESS_TOKEN_ENV} can provide a bearer access token for CI.
  Functional commands require configured credentials, including local task-file and OTD runs.
`,
    env: `Usage:
  octoparse env prod [--json]
  octoparse env online [--json]
  octoparse env status [--json]

Purpose:
  Hidden internal command for switching API environment.
`,
    task: `Usage:
  octoparse task list [--page <n>] [--page-size <n>] [--limit <n>] [--keyword <text>] [--json]
  octoparse task inspect <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
  octoparse task validate <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
`,
    'task list': `Usage:
  octoparse task list [--page <n>] [--page-size <n>] [--limit <n>] [--keyword <text>] [--json]

Options:
  --page <n>          Page number to fetch. Defaults to 1.
  --page-size <n>     Number of tasks per page. Defaults to 20.
  --limit <n>         Alias for --page-size.
  --keyword <text>    Filter tasks by keyword.
  --json              Print a machine-readable JSON envelope.

Examples:
  octoparse task list
  octoparse task list --page 2 --page-size 20
  octoparse task list --keyword news --page 2 --page-size 10
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
  Requires configured credentials even when --task-file points to a local JSON, XML, or OTD file.
  Use --detach for background local extraction.
  Use --max-rows <n> to stop automatically after saving n rows.
  Use --jsonl for foreground event streams.
  JSONL now includes captcha and proxy request events when the runtime asks for them.
  run only starts local extraction. Use data export <taskId> --lot-id <lotId> for files.
  Local Chrome execution supports macOS x64/arm64, Windows x64, and Linux x64.
  Linux arm64 is not supported because Chrome for Testing has no Linux arm64 browser package.
`,
    detect: `Usage:
  octoparse detect <url> --auto [--goal <text>] [--output task.json] [--llm-rank] [--no-dismiss-popups] [--json]
  octoparse detect <url> --manual [--goal <text>] [--llm-rank] [--no-dismiss-popups]
  octoparse detect <url> --agent --agent-command <cmd> [--goal <text>] [--output task.json] [--yes]
  octoparse detect <url> --prepare-agent --json [--goal <text>] [--output context.json]
  octoparse detect --preview-agent-plan plan.json --agent-context context.json [--json]
  octoparse detect --apply-agent-plan plan.json --agent-context context.json --output task.json [--json]

Purpose:
  Open the Octoparse extension browser, inspect the page, and list candidate data regions
  such as tables, repeated cards, search results, link collections, and forms.

Notes:
  Quote URLs that contain '&', '?' or other shell metacharacters, for example:
  octoparse detect 'https://example.com/page?a=1&b=2' --manual
  The first pass is deterministic and does not require an LLM. --auto chooses the
  best candidate and generates a task. --manual opens a guided flow for login,
  popup handling, choosing the highlighted data region, optional session save,
  and task-file generation.
  On Linux servers without DISPLAY/WAYLAND_DISPLAY, non-manual detection
  automatically uses Xvfb when installed. Manual detection needs a visible
  desktop/VNC display because the user must interact with the browser overlay.
  Use --query <keyword> or --input <name=value> to search first, then detect
  and generate a task from the result page. Generated tasks preserve the search
  input XPath and submit action before extracting results.
  If a search page opens a login/captcha/paywall gate, detect pauses in
  interactive/manual mode so the user can complete login in the browser. Use
  --save-session to store same-site cookies; generated tasks inject that session
  before replaying the search.
  detect uses the protected SmartProxy runtime by default. It requires a
  bundled private @octopus/octopus-protect native module. Protected Smart resources are
  fetched encrypted, decrypted in memory, and never written to task files.
  Use --legacy-detector only for debugging the previous heuristic detector.
  If --output is omitted when generating a task, a detected_<host>.json file is created automatically.
  Login/cookie/ad overlays are dismissed automatically when a safe close control is found.
  Use --no-dismiss-popups to inspect the page without this cleanup.
  The manual session-save option stores same-site cookies locally and writes only
  a session reference in generated task files; later local runs load that session automatically.
  Cookie sessions do not cover every site, especially pages that require localStorage,
  device binding, or fresh verification.
  Agents should discover this workflow via "octoparse capabilities --json" and
  machineContract.recipes.createTaskFromUrlWithAgent; users should not need to
  explain the prepare/plan/preview/apply sequence manually.
  If an LLM/agent is helping the user create a scraping task, prefer that recipe
  over handwritten task JSON. The agent should run detect --prepare-agent,
  write a plan from context.json, preview it, apply it, and validate the task.
  Agent workflows generate a full-page screenshot by default and store its path
  in context.screenshot. Pass the user request through --goal so the agent can
  judge candidates against both the natural-language intent and the screenshot.
  Local Chrome execution supports macOS x64/arm64, Windows x64, and Linux x64.
  Linux arm64 is not supported because Chrome for Testing has no Linux arm64 browser package.
  --agent is a one-shot wrapper for external LLM/agent tools. The CLI writes a
  temporary context JSON, runs --agent-command (or OCTOPARSE_AGENT_COMMAND), expects
  a plan JSON at OCTOPARSE_AGENT_PLAN or stdout, previews risk, asks for confirmation
  unless --yes is set, then generates the task. --agent-command executes a local
  shell command; only pass a trusted agent runner. Use --keep-agent-files to retain
  the context/plan for audit. Low-level --prepare-agent/--preview-agent-plan/
  --apply-agent-plan commands remain available for automation and debugging.
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
  octoparse auth login [--oauth] [--no-open] [--json]
  octoparse auth login --api-key <apiKey> [--api-base-url <url>] [--json]
  octoparse auth login <apiKey> [--api-base-url <url>] [--json]
  octoparse auth login [--stdin] [--no-open] [--api-base-url <url>] [--json]
  octoparse auth status [--json]
  octoparse auth logout [--json]
  octoparse browser doctor [--chrome-path <path>] [--json]
  octoparse task list [--page <n>] [--page-size <n>] [--limit <n>] [--keyword <text>] [--json]
  octoparse task inspect <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
  octoparse task validate <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
  octoparse detect URL --auto [--goal <text>] [--output task.json] [--llm-rank] [--no-dismiss-popups] [--json]
  octoparse detect URL --manual [--goal <text>] [--llm-rank] [--no-dismiss-popups]
  octoparse detect URL --agent --agent-command <cmd> [--output task.json] [--yes]
  octoparse detect URL --prepare-agent --json --goal <text> --output context.json
  octoparse detect --preview-agent-plan plan.json --agent-context context.json [--json]
  octoparse detect --apply-agent-plan plan.json --agent-context context.json --output task.json
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
  - Supports local Chrome execution on macOS x64/arm64, Windows x64, and Linux x64.
  - Does not support Linux arm64 local execution because Chrome for Testing has no Linux arm64 browser package.
  - Does not require the Electron client.
  - Cloud extraction is controlled through backend APIs; local extraction is controlled by the local engine.
  - Does not support kernel browser or legacy workflow in v1.

Authentication:
  OAuth or API key credentials are required for all functional commands, including local --task-file and .otd runs.
  Only setup/diagnostic commands can run without it: --help, --version, capabilities, doctor, browser doctor, auth, env.
  API key page:                   ${API_KEYS_URL}
  octoparse auth login --oauth   open browser OAuth login and store tokens
  octoparse auth login <key>     verify and store a copied API key directly
  octoparse auth login          choose OAuth or API key interactively
  octoparse auth login --stdin  read API key from stdin, verify it, then store it
  octoparse auth login --no-open do not open the browser during interactive login
  ${API_KEY_ENV}                  overrides stored credentials
  ${ACCESS_TOKEN_ENV}             uses a bearer access token instead of stored credentials
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
