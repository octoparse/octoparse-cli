# octoparse-cli

Command-line runner for Octoparse extraction tasks.

`octoparse` can list cloud tasks, run tasks locally, control active local
runs, and export collected data.

## Requirements

- Node.js 20 or newer
- A valid Octoparse API key

## Quick start

### 1. Install

Install the CLI globally:

```bash
npm install -g octoparse-cli
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

### 2. Log in with an API key

Most commands require a Octoparse API key. Run:

```bash
octoparse auth login
```

`auth login` opens the API key page automatically in a browser when possible,
then verifies and saves the key locally.

Create the key here:

```text
https://www.octoparse.com/console/account-center/api-keys
```

If you already copied the key, you can save time and pass it directly:

```bash
octoparse auth login XXXXX
```

For CI or scripts, set the key with an environment variable instead:

```bash
OCTO_ENGINE_API_KEY=xxx octoparse task list --json
```

### 3. Use the CLI

List your cloud tasks:

```bash
octoparse task list
```

Inspect a task:

```bash
octoparse task inspect <taskId>
```

Run a task locally:

```bash
octoparse run <taskId>
```

Run in the background:

```bash
octoparse run <taskId> --detach
```

Check or stop an active local run:

```bash
octoparse local status <taskId>
octoparse local stop <taskId>
```

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
octoparse auth login XXXXX
octoparse auth status
octoparse auth logout

# Task discovery
octoparse task list
octoparse task list --keyword news --page-size 10
octoparse task inspect <taskId>

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

## API key

Most commands require an API key. Only setup and diagnostic commands such as
`--help`, `--version`, `doctor`, `browser doctor`, `capabilities`, and `auth`
can run before login.

Create API keys in the Octoparse console:

```text
https://www.octoparse.com/console/account-center/api-keys
```

For interactive use:

```bash
octoparse auth login
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
```

Credential precedence:

```text
1. OCTO_ENGINE_API_KEY
2. ~/.octoparse/credentials.json
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

Clean stale local control state:

```bash
octoparse local cleanup
octoparse runs cleanup
```

## More documentation

- Agent and automation contract: [`docs/AGENT_USAGE.md`](docs/AGENT_USAGE.md)
- JSON schemas: [`docs/SCHEMAS.md`](docs/SCHEMAS.md)
- CLI design notes: [`docs/CLI_DESIGN.md`](docs/CLI_DESIGN.md)
- Publishing notes: [`docs/PUBLISHING.md`](docs/PUBLISHING.md)
