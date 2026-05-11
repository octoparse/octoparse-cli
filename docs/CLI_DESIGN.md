# CLI Design Framework Blueprint

## 1. Purpose

`octoparse` runs Octoparse task definitions locally through the embedded `@octopus/engine` and independent Chrome, without depending on the Electron client.

## 2. Classification

- **Primary role**: Runtime
- **Primary user type**: Balanced
- **Primary interaction form**: Batch CLI
- **Statefulness**: Sessionful + Long-running for active local runs; foreground and detached runs expose a temporary control channel without requiring a daemon
- **Risk profile**: Mixed
- **Secondary surfaces**:
  - Capability surface for task definition inspection and run artifact query
  - JSON / JSONL machine-readable output
  - Human-readable table and progress output
- **Confidence level**: High
- **Hybrid notes**: Product center is Runtime. `task inspect`, `local history`, and `local export` are Capability-like supporting surfaces.
- **Evolution trajectory**: v1 foreground runtime -> local run registry and detached child runtime -> optional daemon-backed runtime.

## 2b. Classification reasoning

The old `octo-cli` was a Capability CLI because it controlled task resources already hosted by the Electron client. This project embeds the execution engine, so the center of gravity becomes process lifecycle: starting a run, streaming rows/logs, stopping cleanly, writing artifacts, and later attaching to detached runs.

It is not primarily a Workflow/Orchestration CLI yet. `run --export` or future chaining may exist, but v1 should not become a general pipeline system.

It is Balanced because removing either the human or machine surface would harm core workflows:

- Operators need readable progress, diagnostics, and browser setup help.
- Agents/scripts need JSONL event streams, stable run metadata, explicit exit codes, and bounded data reads.

## 3. Primary design stance

Optimize for a reliable, inspectable, local engine runtime that can run one task definition end-to-end without the Electron client. Do not optimize v1 for GUI parity, cloud/local duality, or a daemon-first control plane. The CLI should expose the real runtime model clearly: task definition in, run instance out, artifacts on disk.

## 4. Command structure

Recommended top-level shape:

```bash
octoparse doctor
octoparse browser doctor
octoparse task list
octoparse task inspect <taskId>

octoparse run <taskId>
octoparse run <taskId> --detach
octoparse cloud start <taskId>
octoparse cloud stop <taskId>
octoparse cloud status <taskId>
octoparse cloud history <taskId>
octoparse local status <taskId>
octoparse local pause <taskId>
octoparse local resume <taskId>
octoparse local stop <taskId>
octoparse local history <taskId>
octoparse local export <taskId>
octoparse local export <taskId> --lot-id <lotId>
octoparse data history <taskId> --source local|cloud
octoparse data export <taskId> --source local|cloud
```

The singular `run` starts a new runtime execution. Active local control and local data export are addressed by `taskId`. Repeated local collections of the same task are exposed as `lotId` batches for history/export selection. Internal `runId` remains an artifact implementation detail.

## 5. Input model

Use flags-first input for human and script use:

```bash
octoparse run <taskId> --jsonl --headless
```

Add raw payload input later only if agents need to submit full task definitions:

```bash
octoparse run --task-file task.json
```

Do not require raw JSON for ordinary runs.

## 6. Output model

- Default foreground output: human-readable progress and summary.
- `--json`: one structured response for commands that finish quickly.
- `--jsonl`: event stream for long-running `run`.
- Data artifacts: `rows.jsonl`, `events.jsonl`, `logs.jsonl`, `meta.json`.
- `run` does not use `--format`; file format selection belongs to `data export --format`.

Example event stream:

```jsonl
{"event":"run.started","runId":"run_20260424_001","taskId":"abc123"}
{"event":"row","runId":"run_20260424_001","total":1,"data":{"title":"example"}}
{"event":"log","runId":"run_20260424_001","level":"info","message":"navigated"}
{"event":"run.stopped","runId":"run_20260424_001","status":"completed","total":128}
```

## 7. Help / discoverability / introspection

Human discoverability requirements:

- `--help` on every command.
- `doctor` explains missing browser/runtime/auth/config issues.
- `task inspect` shows required execution inputs: XML, XOML, fields, browser settings, proxy settings, and unsupported features.

Machine introspection requirements:

- `--json` on `capabilities`, `doctor`, `auth`, `task`, `cloud`, `local`, `data`, and internal `runs` commands.
- `capabilities --json` describes authentication, output surfaces, exit codes, common error codes, and artifact contracts.
- `local history --schema` and richer data stats can be added after artifacts mature.

## 8. State / session model

v1 local runtime mode:

- No daemon is required.
- A configured API key is required for all functional operations, including local `--task-file` and `.otd` runs.
- `taskId` is the user-facing identity for active local control.
- `lotId` is the user-facing identity for a local collection batch/history item.
- `runId` is created at start and written to local artifacts as an internal execution/artifact id.
- `Ctrl+C` maps to graceful `stop`.
- Active foreground runs expose a temporary local control socket.
- `local pause/resume/stop <taskId>` controls the active local engine process.
- `run <taskId> --detach` starts local collection in a detached child process and returns after the child either exposes its control channel or fails startup.
- Detached startup writes `<output>/.detach_<taskId>_<timestamp>/bootstrap.json`, `stdout.log`, and `stderr.log` so early child failures are observable before a run artifact exists.
- If a control socket disappears while its control file remains, status surfaces report `orphaned` and cleanup commands remove the stale files.
- `local cleanup` removes stale task-level active control files; `runs cleanup --output <dir>` removes stale run-level `control.json` files and matching task-level active files.

Future daemon mode:

- Explicit daemon lifecycle.
- `lotId` remains the user-facing local collection batch id; daemon internals may keep a separate process/session id.
- Detached runs can be listed, stopped, paused, resumed, and tailed.

## 9. Risk / safety model

- Low-risk operations:
  - `capabilities`, `doctor`, `task list`, `task inspect`, `local status`, `local history`, `local cleanup`, `data history`, `runs list/status/logs/data/cleanup`.
  - Guardrails: bounded default limits and clear errors.
- Medium-risk operations:
  - `run`, `cloud start/stop`, `local pause/resume/stop`, `local export`, `data export`, `runs export`.
  - Guardrails: explicit output directory, overwrite checks, clear browser profile path.
- High-risk operations:
  - Future `runs stop`, batch stop, deleting run artifacts, overwriting files.
  - Guardrails: `--dry-run`, `--force`, impact preview, no inferred destructive scope.

`--yes` should skip prompts but should not silently imply destructive overwrite. Use `--force` for overwrites/deletes.

## 10. Hardening model

- Stable exit codes:
  - `0`: success
  - `1`: operation failed
  - `2`: runtime/environment failure
  - `3`: task definition invalid or unsupported
- Validate task definition before engine startup.
- Reject unsupported browser modes instead of silently falling back.
- Bound data output with `--limit` and `--offset`.
- Make timeout behavior explicit for browser startup and task bootstrap.

## 11. Secondary surface contract

### JSON

For quick commands, `--json` returns an envelope:

```json
{"ok":true,"data":{}}
```

Failures return:

```json
{"ok":false,"error":{"code":"ENGINE_START_FAILED","message":"..."}}
```

### JSONL

For `run --jsonl`, each line is one event object with a stable `event` field. New fields may be added, existing fields are not renamed without deprecation.

### Local artifacts

Artifacts are a strong internal contract for local history/export:

```text
<output>/<runId>/
  meta.json
  events.jsonl
  rows.jsonl
  logs.jsonl
```

## 12. v1 boundaries

v1 should include:

- Independent Chrome-only foreground run.
- Task definition resolution boundary.
- EngineHost wrapper around `@octopus/engine`.
- Local artifact writer.
- Detached local run bootstrap observability.
- Active local control by `taskId`.
- Cloud start/stop/status/history through backend APIs.
- Unified local/cloud data history and export.
- `capabilities`, `doctor`, `run`, `local status/history/export`, `data history/export`.
- JSON and JSONL contracts, including JSON envelopes for usage errors when `--json` is present.

v1 should defer:

- Kernel browser.
- Legacy workflow engine.
- Full GUI parity.
- Daemon-managed multi-run orchestration.
- Destructive artifact deletion / overwrite-by-default behavior.

Premature abstractions:

- General workflow pipeline engine.
- Multi-tenant daemon.
- Remote control server.
- Plugin marketplace.

## 13. Direction for implementation

Optimize for one reliable local end-to-end run before building background management. Keep the runtime boundary clean so it can later move behind a daemon without changing user-facing run artifacts.

Acceptable patterns:

- Foreground process owns one run.
- EventEmitter-based EngineHost.
- JSONL event stream for long operations.
- Local filesystem run registry.

Category mistakes:

- Recreating the Electron client inside the CLI.
- Continuing to model execution only by `taskId`.
- Supporting `--cloud`, kernel browser, and old workflow in the standalone path.
- Making daemon mode a prerequisite for the first working prototype.
