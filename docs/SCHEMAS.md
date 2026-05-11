# JSON Schemas

The CLI exposes versioned JSON Schemas for the stable agent-facing machine surfaces.

Current schemas:

| Schema | Purpose |
| --- | --- |
| `schemas/json-envelope-v1.schema.json` | Common `--json` success/failure envelope. |
| `schemas/capabilities-v1.schema.json` | Full `octoparse capabilities --json` response. |
| `schemas/run-event-v1.schema.json` | One line from `octoparse run <taskId> --jsonl`. |
| `schemas/detached-bootstrap-v1.schema.json` | Detached startup `bootstrap.json` artifact. |

`octoparse capabilities --json` publishes these paths under:

```text
data.machineContract.schemas
```

Compatibility rules:

- Schema `v1` is additive: new optional fields may be added.
- Existing required fields, error envelope fields, and stable event names should not be removed or renamed in v1.
- Breaking changes require a new schema version and a higher `agentContractVersion`.
- Agents should ignore unknown fields and validate only the schema version they support.

Command coverage guidance:

- Public agent-facing commands need contract tests for key success and failure behavior.
- Internal/debug commands do not need every flag combination tested, but their `--json` output and error envelope should remain valid if advertised in `capabilities`.
- Human-only text output is not a stable schema surface.
