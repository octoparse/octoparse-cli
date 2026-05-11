# Architecture Sketch

## Target runtime

```text
CLI command
  -> TaskDefinitionProvider
  -> EngineHost
  -> @octopus/engine WorkflowAgent
  -> independent Chrome
  -> ArtifactWriter
```

## Extract from current Electron implementation

The current client path is:

```text
renderer EngineClient.register(...)
  -> main/ipc/engine.ts
  -> BridgeHub
  -> new WorkflowAgent(...)
  -> workflow.start({ headless: false, path })
  -> electronAPI.sender.send(...)
```

Standalone CLI should extract the reusable pieces:

- `BridgeHub`
- `WorkflowAgent` construction
- event mapping from `WorkflowEvents`
- browser runtime resolution

and replace Electron IPC with:

- `EventEmitter`
- local JSONL artifact writer
- optional future daemon RPC

## Runtime boundary

`EngineHost` should expose:

```ts
start(input): Promise<RunSummary>
stop(runId): Promise<void>
pause(runId): Promise<void>
resume(runId): Promise<void>
on('row' | 'log' | 'stopped' | 'captcha' | 'proxy', listener)
```

For v1 only `start` and graceful `stop` on signal are required.

Current status:

- `BridgeHub` is implemented without Electron IPC.
- `EngineHost` launches real `WorkflowAgent`.
- `--task-file` loads local task definitions.
- XML-only task files are transformed through `@octopus/engine/transformer`.
- Engine logs and rows are written to local JSONL artifacts.

## Run artifact layout

```text
.octoparse/runs/<runId>/
  meta.json
  events.jsonl
  rows.jsonl
  logs.jsonl
```

This local registry is intentionally separate from the Electron client's SQLite storage.
