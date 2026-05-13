# Agent Usage

`octoparse` exposes stable machine-oriented surfaces for automation. Agents should prefer those surfaces and avoid parsing human-readable output.

## Discovery

Use `capabilities --json` as the canonical discovery entrypoint:

```bash
octoparse capabilities --json
```

Helpful read-only help commands:

```bash
octoparse --help
octoparse run --help
octoparse data export --help
```

`capabilities --json` publishes the current machine contract, including:

- JSON envelope shape
- Common error codes
- JSONL run event metadata
- Bundled schema file paths under `data.machineContract.schemas`
- Authentication and lifecycle constraints

## Output contract

Use `--json` for request/response commands. The CLI writes exactly one JSON object to stdout:

```json
{
  "ok": true,
  "data": {}
}
```

Failures use the same envelope:

```json
{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "human-readable message"
  }
}
```

When `--json` is present, usage failures also use the same envelope. Common error codes are discoverable from:

```bash
octoparse capabilities --json
```

Path:

```text
data.machineContract.json.commonErrorCodes
```

Use `--jsonl` for foreground local runs:

```bash
octoparse run <taskId> --jsonl
```

Each line is one event object. Agents should switch on the stable `event` field. Stable lifecycle events are published by `capabilities --json`. Runtime-specific operational events such as `captcha` and `proxy` can also appear when the engine requests them.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Success |
| 1 | Operation failed |
| 2 | Runtime or environment failure |
| 3 | Unsupported task definition |

Treat any non-zero exit code as failure.

## Authentication

An API key is required for all functional commands, including local `--task-file` and `.otd` runs.

Commands available before authentication:

- `--help`
- `--version`
- `capabilities`
- `doctor`
- `browser doctor`
- `auth login`
- `auth status`
- `auth logout`
- `env status`
- `env prod`
- `env online`

Non-interactive setup:

```bash
printf '%s' "$API_KEY" | octoparse auth login --stdin --json
```

`auth login` verifies the key before saving `~/.octoparse/credentials.json`. Invalid or environment-mismatched keys fail with `AUTH_INVALID` and are not saved.

Environment variables:

```bash
OCTO_ENGINE_API_KEY=<api-key>
OCTO_ENGINE_API_BASE_URL=https://example.com
```

`OCTO_ENGINE_API_KEY` overrides stored credentials.

## Recommended agent workflows

List tasks:

```bash
octoparse task list --json
```

Inspect or validate a task before running:

```bash
octoparse task inspect <taskId> --json
octoparse task validate <taskId> --task-file ./task.json --json
```

Start local collection in the background:

```bash
octoparse run <taskId> --detach --json
```

Detached startup returns machine-readable bootstrap details including:

- `bootstrapDir`
- `stdout`
- `stderr`

If the child exits before the local control channel becomes ready, the command fails with `DETACHED_RUN_FAILED`. Inspect the bootstrap directory for `bootstrap.json`, `stdout.log`, and `stderr.log`.

Control local collection:

```bash
octoparse local status <taskId> --json
octoparse local pause <taskId> --json
octoparse local resume <taskId> --json
octoparse local stop <taskId> --json
octoparse local cleanup --json
```

If a previous local owner process exits without cleaning its control file, `local status` returns `active: false`, `status: "not_running"`, and stale-state metadata such as `cleanedStaleState`, `lastStatus`, and `lastRunId`. `local cleanup` removes stale task-level control files in bulk.

Inspect or export collected data through task-oriented commands:

```bash
octoparse data history <taskId> --source local --json
octoparse data history <taskId> --source cloud --json
octoparse data export <taskId> --source local --format xlsx --json
octoparse data export <taskId> --source cloud --format csv --json
octoparse data export <taskId> --source cloud --lot-id <lotId> --file result.csv --json
```

If `--file` is omitted, the CLI creates a filename from the task name. Existing files are not overwritten; the CLI appends Windows-style suffixes such as ` (1)` and ` (2)`.

Control cloud collection:

```bash
octoparse cloud start <taskId> --json
octoparse cloud stop <taskId> --json
octoparse cloud status <taskId> --json
octoparse cloud history <taskId> --json
```

For low-level local artifact inspection, internal `runs` commands remain available:

```bash
octoparse runs list --json
octoparse runs status <runId> --json
octoparse runs logs <runId> --json
octoparse runs data <runId> --json
octoparse runs cleanup --json
```

Prefer task-oriented commands for normal user or agent flows. Use `runs` only when you need direct access to local artifact state by `runId`.

## Agent rules

- Prefer `--json` or `--jsonl`.
- Authenticate first; do not assume local task files bypass API key requirements.
- Do not parse human-readable stdout or stderr.
- Use `taskId` for user-facing task operations.
- Use `lotId` only to select a specific collection batch.
- Use `runId` only for internal local artifact inspection.
- Cloud collection supports `start` and `stop`; it does not support `pause` or `resume`.
