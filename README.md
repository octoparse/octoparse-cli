# octoparse-cli

Command-line runner for Octoparse extraction tasks.

`octoparse` can list cloud tasks, run tasks locally, control active local
runs, and export collected data.

## Requirements

- Node.js 20 or newer
- A valid Octoparse account or API key

## Quick start

### 1. Install

Install the CLI globally:

```bash
npm install -g @octoparse-cli/octoparse-cli
```

The installed command is:

```bash
octoparse
```

Check the installation:

```bash
octoparse --version
octoparse doctor
```

### 2. Log in

Most commands require Octoparse credentials. Run:

```bash
octoparse auth login
```

`auth login` lets you choose OAuth or API key login. OAuth opens the browser,
then saves the token locally after login.

To force OAuth login:

```bash
octoparse auth login --oauth
```

API key login is still supported. Create the key here:


```text
https://www.octoparse.com/console/account-center/api-keys
```

If you already copied the key, you can save time and pass it directly:

```bash
octoparse auth login XXXXX
```

For CI or scripts, set an environment variable instead:

```bash
OCTO_ENGINE_API_KEY=xxx octoparse task list --json
OCTO_ENGINE_ACCESS_TOKEN=xxx octoparse task list --json
```

### 3. Use the CLI

Query the task list:

```bash
octoparse task list
octoparse task list --page 2 --page-size 20
```

Query a single task:

```bash
octoparse task inspect <taskId>
```

Run a task locally:

```bash
octoparse run <taskId>
```

Local Chrome execution is supported on macOS x64/arm64, Windows x64, and
Linux x64. Linux arm64 is not supported by the local CLI runtime because Chrome
for Testing does not currently provide a Linux arm64 browser package; use a
supported local platform or cloud extraction there.

Create a local task from a URL directly with CLI-only selection:

```bash
octoparse detect 'https://example.com/list' --auto --output task.json
octoparse detect 'https://example.com/search' --manual --query keyword --save-session --output task.json
```

`detect` uses the protected SmartProxy detector by default and requires
configured credentials. Manual mode can save a cookies-only browser session for
later local runs. Agent mode is available through `--agent --agent-command`;
that command executes a local shell command and should only point to a trusted
agent runner.

If an LLM/agent is helping a user create a task with Octoparse CLI, it should
run `octoparse capabilities --json` first and follow
`machineContract.recipes.createTaskFromUrlWithAgent`. That recipe tells the
agent to use `detect --agent` with a trusted agent runner for the shortest
create-task path, adding `--run-sample <n>` when immediate sample rows are
needed. The lower-level prepare/plan/preview/apply workflow remains available
for audit and repair instead of asking the user to explain internal detect
flags, using `--auto` as the default path, or hand-writing JSON.
Agent workflows generate a full-page
screenshot by default and store it in `context.screenshot`; pass the user's
natural-language request with `--goal` so the agent can judge candidates against
both the visual page and the stated intent. The context also includes
`resultValidationPolicy`; agents should treat isolated missing fields in ads,
topic cards, sponsored items, or heterogeneous rows as normal partial data
instead of repeatedly recreating the task.

Run in the background:

```bash
octoparse run <taskId> --detach
```

Query the local run status, or stop the local process running a task:

```bash
octoparse local status <taskId>
octoparse local stop <taskId>
```

Note: local run status is tracked by this CLI only and is not synchronized with
the Octoparse desktop client status.

Export data:

```bash
octoparse data export <taskId> --source local --format xlsx
octoparse data export <taskId> --source cloud --format csv
```

## Common commands

```bash
# Help and diagnostics
octoparse --help
octoparse doctor
octoparse browser doctor

# Authentication
octoparse auth login
octoparse auth login --oauth
octoparse auth login XXXXX
octoparse auth status
octoparse auth logout

# Task discovery
octoparse task list
octoparse task list --page 2 --page-size 20
octoparse task list --keyword news --page 2 --page-size 10
octoparse task inspect <taskId>

# Task creation
octoparse detect 'https://example.com/list' --auto --output task.json
octoparse detect 'https://example.com/search' --manual --query keyword --save-session --output task.json

# Local extraction
octoparse run <taskId>
octoparse run <taskId> --jsonl
octoparse run <taskId> --detach
octoparse local status <taskId>
octoparse local pause <taskId>
octoparse local resume <taskId>
octoparse local stop <taskId>

# Cloud extraction
octoparse cloud start <taskId>
octoparse cloud stop <taskId>
octoparse cloud status <taskId>
octoparse cloud history <taskId>

# Data
octoparse data history <taskId> --source local
octoparse data history <taskId> --source cloud
octoparse data export <taskId> --source local --format xlsx
octoparse data export <taskId> --source cloud --format csv
```

By default, local run artifacts are stored in `~/.octoparse/runs`. If you
customize the run artifact directory with `--output`, use the same `--output`
again when reading local history or exporting local data:

```bash
octoparse run <taskId> --output ./runs
octoparse data history <taskId> --source local --output ./runs
octoparse data export <taskId> --source local --output ./runs --format xlsx
```

## Authentication

Most commands require OAuth or API key credentials. Only setup and diagnostic commands such as
`--help`, `--version`, `doctor`, `browser doctor`, `capabilities`, and `auth`
can run before login.

For interactive OAuth login:

```bash
octoparse auth login
octoparse auth login --oauth
```

Create API keys in the Octoparse console:

```text
https://www.octoparse.com/console/account-center/api-keys
```

If the API key is already copied:

```bash
octoparse auth login XXXXX
```

Use `--no-open` if you want to copy the URL manually:

```bash
octoparse auth login --no-open
```

For CI or scripts:

```bash
OCTO_ENGINE_API_KEY=xxx octoparse task list --json
OCTO_ENGINE_ACCESS_TOKEN=xxx octoparse task list --json
```

Credential precedence:

```text
1. OCTO_ENGINE_API_KEY
2. OCTO_ENGINE_ACCESS_TOKEN
3. ~/.octoparse/credentials.json
```

## Local task files

You can run or validate a local task definition file:

```bash
octoparse task validate <taskId> --task-file ./task.json
octoparse run <taskId> --task-file ./task.json
octoparse run sample --task-file ./sample.otd
```

Supported local task file types:

- `.json`
- `.xml`
- `.otd`

Kernel browser tasks are not supported in this CLI.

## Machine-readable output

Use `--json` for one JSON response:

```bash
octoparse task list --json
octoparse local status <taskId> --json
```

Use `--jsonl` for local run event streams:

```bash
octoparse run <taskId> --jsonl
```

The stream includes `captcha` and `proxy` events when the runtime asks the CLI
to resolve CAPTCHA or proxy resources automatically.

Local run artifacts are written under `~/.octoparse/runs` by default, or under
the selected `--output` directory when configured:

```text
<output>/<runId>/
  meta.json
  events.jsonl
  logs.jsonl
  rows.jsonl
```

## Troubleshooting

Check the local environment:

```bash
octoparse doctor
octoparse browser doctor
```

If the browser is not detected automatically, pass its path:

```bash
octoparse run <taskId> --chrome-path "/path/to/chrome"
```

Linux arm64 local execution is not supported, even with `--chrome-path`,
because the bundled local runtime depends on Chrome for Testing platform
support.

Clean stale local control state:

```bash
octoparse local cleanup
octoparse runs cleanup
```
