# @gobing-ai/ts-dual-workflow-engine

State-machine and transition-flow workflow runtime with pluggable action runners, guard runners, and memory or database persistence.

## What It Provides

`ts-dual-workflow-engine` runs declarative workflows in two execution modes:

| Mode | Use When |
|------|----------|
| `state-machine` | A run owns one current state and chooses the next state by evaluating ordered transition guards |
| `transition-flow` | A run moves through nodes and edges in a DAG-like flow, executing node actions as it advances |

The package exposes:

| Export | Purpose |
|--------|---------|
| `WorkflowService` | High-level loader and runner for both workflow kinds |
| `StateMachineDriver` | Direct state-machine execution |
| `TransitionFlowDriver` | Direct transition-flow execution |
| `WorkflowEngineHost` | Registry for action runners and guard runners |
| `MemoryWorkflowPersistenceAdapter` | In-memory persistence for tests and short-lived runs |
| `DbWorkflowPersistenceAdapter` | DB-backed persistence over `@gobing-ai/ts-db` |
| `loadWorkflowDef()` / `loadWorkflowDefFromText()` | YAML workflow loading and validation |
| `applyWorkflowEngineSchema()` | Installs the package-owned DB schema |

## Installation

```bash
bun add @gobing-ai/ts-dual-workflow-engine @gobing-ai/ts-db
```

Use `@gobing-ai/ts-db` only when you need durable workflow history. Memory persistence has no database requirement.

## State Machine Example

```ts
import {
    MemoryWorkflowPersistenceAdapter,
    StateMachineDriver,
    WorkflowEngineHost,
    type ActionRunner,
} from '@gobing-ai/ts-dual-workflow-engine';

const captureAction: ActionRunner = {
    kind: 'capture',
    async execute(options) {
        console.log(options.message);
        return { ok: true };
    },
};

const host = new WorkflowEngineHost()
    .registerAction(captureAction)
    .registerGuard({ kind: 'always', evaluate: async () => true });

const driver = new StateMachineDriver({
    host,
    persistence: new MemoryWorkflowPersistenceAdapter(),
});

const result = await driver.run(
    {
        name: 'approval',
        initialState: 'draft',
        terminalStates: ['done'],
        vars: { message: 'approved' },
        states: [
            { id: 'draft', onEnter: [{ kind: 'capture', options: { message: '${vars.message}' } }] },
            { id: 'done' },
        ],
        transitions: [{ from: 'draft', to: 'done', guard: { kind: 'always' } }],
    },
    { runId: 'approval-1' },
);

console.log(result.status, result.finalState);
```

The driver persists each state snapshot, phase update, transition, and final run status through the configured persistence adapter.

## Transition Flow Example

```ts
import {
    createDefaultWorkflowEngineHost,
    MemoryWorkflowPersistenceAdapter,
    WorkflowService,
} from '@gobing-ai/ts-dual-workflow-engine';

const service = new WorkflowService(
    createDefaultWorkflowEngineHost(),
    new MemoryWorkflowPersistenceAdapter(),
);

const result = await service.run({
    kind: 'transition-flow',
    name: 'linear-flow',
    initialNode: 'start',
    terminalNodes: ['done'],
    nodes: [
        { id: 'start', action: { kind: 'note', options: { message: 'started' } } },
        { id: 'done' },
    ],
    edges: [{ from: 'start', to: 'done' }],
});

console.log(result);
```

The default host includes built-in `note` and `shell` action runners plus an `always` guard. For production systems, register domain-specific runners and keep shell execution explicit.

## Load Workflows from YAML

```ts
import { loadWorkflowDef, WorkflowService } from '@gobing-ai/ts-dual-workflow-engine';

const workflow = await loadWorkflowDef('./workflows/approval.yaml');
await service.run(workflow, { runId: 'approval-1' });
```

`loadWorkflowDef(path)` reads YAML or JSON from disk. File loads honor a top-level `$schema` ref by default, then validate the internal structural schema and semantic references before returning a `WorkflowDef`. `loadWorkflowDefFromText(text, source)` handles inline definitions with internal validation only.

### State-machine YAML

`kind: state-machine` is optional because state-machine is the default shape, but including it makes the file easier to scan.

```yaml
# workflows/approval.yaml
$schema: "https://raw.githubusercontent.com/gobing-ai/ts-libs/main/packages/dual-workflow-engine/schemas/state-machine-workflow.schema.json"
kind: state-machine
name: approval
initialState: draft
terminalStates: [done]
vars:
  reviewer: robin
env:
  allow: [APP_ENV]
states:
  - id: draft
    onEnter:
      - kind: note
        options:
          message: "review requested by ${vars.reviewer} in ${env.APP_ENV}"
  - id: approved
    onEnter:
      - kind: note
        options:
          message: approved
  - id: done
transitions:
  - from: draft
    to: approved
    guard:
      kind: always
  - from: approved
    to: done
```

```ts
import {
    createDefaultWorkflowEngineHost,
    loadWorkflowDef,
    MemoryWorkflowPersistenceAdapter,
    WorkflowService,
} from '@gobing-ai/ts-dual-workflow-engine';

const service = new WorkflowService(
    createDefaultWorkflowEngineHost(),
    new MemoryWorkflowPersistenceAdapter(),
);

const workflow = await loadWorkflowDef('./workflows/approval.yaml');
const result = await service.run(workflow, {
    runId: 'approval-1',
    env: { APP_ENV: 'development' },
});
```

### Transition-flow YAML

Transition-flow definitions must declare `kind: transition-flow`.

```yaml
# workflows/import-file.yaml
$schema: "https://raw.githubusercontent.com/gobing-ai/ts-libs/main/packages/dual-workflow-engine/schemas/transition-flow-workflow.schema.json"
kind: transition-flow
name: import-file
initialNode: read
terminalNodes: [done]
vars:
  file: events.jsonl
nodes:
  - id: read
    type: action
    action:
      kind: note
      options:
        message: "reading ${vars.file}"
  - id: validate
    type: gate
  - id: done
edges:
  - from: read
    to: validate
  - from: validate
    to: done
    condition:
      kind: always
```

```ts
const workflow = await loadWorkflowDef('./workflows/import-file.yaml');
const result = await service.run(workflow, {
    runId: 'import-1',
    vars: { file: 'override.jsonl' },
});
```

`validateWorkflowDef()` is available when the caller already has an object and only needs validation.

## Variables and Environment

Actions receive resolved template values. The engine supports:

| Template | Source |
|----------|--------|
| `${vars.name}` | Workflow vars merged with run vars |
| `${env.NAME}` | Environment values explicitly allowed by workflow config |
| `${runId}` | Current run ID |
| `${workflow}` | Workflow name |
| `${state}` | Current state or node ID |

```ts
await service.run(workflow, {
    vars: { file: 'events.jsonl' },
    env: { API_TOKEN: process.env.API_TOKEN },
    metadata: { requestedBy: 'scheduler' },
});
```

The workflow definition controls which environment names are visible through `env.allow`.

## DB Persistence

```ts
import { createDbAdapter } from '@gobing-ai/ts-db';
import {
    applyWorkflowEngineSchema,
    createDefaultWorkflowEngineHost,
    DbWorkflowPersistenceAdapter,
    WorkflowService,
} from '@gobing-ai/ts-dual-workflow-engine';

const db = await createDbAdapter({ driver: 'bun-sqlite', url: './workflow.db' });
await applyWorkflowEngineSchema(db);

const service = new WorkflowService(
    createDefaultWorkflowEngineHost(),
    new DbWorkflowPersistenceAdapter(db),
);
```

Use `service.listRuns()` to read persisted run records. The adapter stores run status, phase snapshots, state snapshots, and transitions.

## Error Handling

Validation failures throw `WorkflowValidationError`. Runtime finite-state-machine errors throw `FSMError`. Run failures caused by actions or guards are returned as `WorkflowRunResult` with `status: 'failed'`, preserving the run record.

## Boundary Notes

- The engine executes workflows; it does not provide a scheduler. Use `@gobing-ai/ts-infra` scheduler or an external cron trigger to start runs.
- Persistence is adapter-based. Downstream apps own DB lifecycle and migration ordering.
- Action and guard runners are the extension points. Keep domain behavior there, not in workflow parsing.
