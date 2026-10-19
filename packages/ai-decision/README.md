# @gobing-ai/ts-ai-decision

The home of the **decision family** in ts-libs: declarative YAML **decision catalogs**, the
**`DecisionMakerRegistry`** that names every decision maker, and the fallback-guaranteed
**`DecisionHub`** that serves them (ADR-033). Applications depend on this package; the concrete
decision backends stay in their own packages and are bundled or registered here.

A catalog declares named, static decision points whose shape follows TypeSafe AI's Jev question
spec (`type` / `instructions` / `criteria`), with a required `fallback`, so every decision always
has a concrete answer no matter which backend is configured or available.

## The decision family at a glance

| Layer | Package | Owns |
|-------|---------|------|
| Contract | `@gobing-ai/ts-ai-runner` | Neutral `Question` / `Answer` types, `DecisionDriver`, `createDecisionMaker`, `validateQuestions` / `validateAnswers`, the `Decision*Error` taxonomy |
| Hub (this package) | `@gobing-ai/ts-ai-decision` | Catalog schema + loader, parameter rendering, `DecisionMakerRegistry`, `DecisionHub`, `createDecisionHub` |
| Backends | `ts-decision-fm`, `ts-laya-mlx`, `ts-decision-clef` (+ TypeSafe via ts-ai-runner today) | One `DecisionDriver` each; they depend only on the contract, never on this package |

The dependency direction is fixed: backends → contract, hub → contract + bundled backends. That is
why backends live outside this package (ADR-033, ADR-037) — a backend that imported the hub would
create a cycle with the bundled built-ins.

### Decision makers

| Maker name | Backend | Package | Registered | Needs | Probabilities |
|------------|---------|---------|------------|-------|---------------|
| `typesafe` | TypeSafe Jev (hosted) | this package (`@typesafe-ai/sdk` 0.7.0) | built-in, lazy; hub default | `TYPESAFE_API_KEY` | from the API |
| `fm-local` | Apple Foundation Models via `fm` (ADR-029/030) | `ts-decision-fm` | built-in, lazy | macOS on Apple silicon, `fm` CLI | k-sample frequencies |
| `laya-local` | Laya on MLX, warm Python worker (ADR-027/028) | `ts-laya-mlx` | built-in, lazy | Apple silicon, Laya model + Python env | from the local model |
| `llm-agent` | Any `ts-ai-runner` coding agent / model (ADR-038) | this package (`ts-ai-runner` surface) | built-in, lazy | an installed agent CLI | k-sample frequencies |
| `clef` | Cloudflare Workers AI Clef (ADR-037) | `ts-decision-clef` | consumer-registered | Cloudflare account ID + API token | from the API |

Built-ins are registered lazily: naming, listing and describing makers never constructs a driver,
so a host without a backend's prerequisites only notices when a decision actually routes to it —
and then gets the declared fallback (`reason: 'no-backend'` or `'error'`), not an exception.

## Quick start

```ts
import { createDecisionHub } from '@gobing-ai/ts-ai-decision';

const hub = await createDecisionHub({ catalogs: ['decisions/support.yaml'] });

const r = await hub.decide('category', { instructions: ticketText, channel: 'chat' });
// { id, type, value, confidence, source, reason, maker, durationMs }
```

`createDecisionHub` composes registry + catalogs in one call and never returns a partially built
hub. See `examples/decisions.yaml` for a complete catalog.

## Catalog format

```yaml
# decisions/support.yaml
$schema: "@gobing-ai/ts-ai-decision/schemas/decision-catalog.schema.json"
version: 1
decisions:
  category:
    type: choice
    instructions: "Classify this ${params.channel} ticket: ${params.instructions}"
    parameters:
      channel: { type: enum, values: [email, chat], default: email }
    criteria:
      bug_report: Something is broken or producing errors
      billing: Charges, invoices, refunds, subscriptions
    fallback: billing
```

```ts
import { buildState, loadDecisionCatalog, renderQuestion, resolveDecisionInput } from '@gobing-ai/ts-ai-decision';

const catalog = await loadDecisionCatalog('decisions/support.yaml');
const decision = catalog.decisions.category;

const params = resolveDecisionInput(decision, { instructions: ticketText, channel: 'chat' });
const question = renderQuestion(decision, params); // rendered Jev question
const state = buildState(decision, params);        // declared params, minus instructions/nulls
```

Loading is YAML-only (`.yaml` / `.yml`) and reuses ts-runtime's `parseStructuredConfig`, so the
`$schema` header is honoured when present and no YAML dependency is added here. Inconsistent
catalogs (fallback outside the answer vocabulary, `${...}` refs to undeclared params or other
namespaces, a declared reserved `instructions` parameter, mismatched defaults) throw
`DecisionCatalogError { source, decisionId?, field? }`; input-contract violations throw
`DecisionInputError { decisionId, param }`.

The reserved `instructions` parameter carries caller text to the model: every decision
implicitly has one (type `string`, default `""`), it cannot be declared under `parameters`, and
an authored `instructions` template embeds it with `${params.instructions}` beside other
parameters. Every string leaf of `instructions` and of the criteria descriptions is substituted
once per `decide`; criteria labels, `fallback`, `maker` and `model` are never templated, so the
answer vocabulary stays static. `${env.*}` and any other namespace are rejected at load.

## DecisionHub

```ts
import { DecisionHub } from '@gobing-ai/ts-ai-decision';

const hub = new DecisionHub();                 // registry with the built-ins, defaultMaker 'typesafe'
await hub.loadFile('decisions/support.yaml');  // or hub.load(loadedCatalog)

hub.list();                                    // [{ id, type, description, source }] — pure discovery
hub.describe('category');                      // parameters (incl. instructions), criteria, fallback,
                                               // effective minConfidence, maker and model
const r = await hub.decide('category', { instructions: ticketText }, { maker: 'fm-local' });
```

`load` is all-or-nothing per catalog: a duplicate decision id across catalogs, or a `maker`
name (decision or `defaults.maker`) that is not registered, throws `DecisionCatalogError` and
registers nothing from the offending catalog. `list` and `describe` never construct a maker or
driver.

The hub picks a maker purely by name — per-call `options.maker` → the decision's `maker` → the
catalog's `defaults.maker` → the hub's `defaultMaker` (default `typesafe`). Catalog names are
checked at `load`; a misspelled per-call name fails loudly instead of falling back.

### The fallback contract

`decide` never rejects for backend outcomes — only caller mistakes throw (`UnknownDecisionError`
for an unknown id, `DecisionInputError` for input breaking the parameter contract,
`UnknownDecisionMakerError` for an unregistered per-call maker; the constructor throws for an
unregistered `defaultMaker`). Every throw happens before any backend call.

Exactly one Jev question keyed by the decision id goes through a single
`maker.ask({ state, questions, model })`; `model` resolves decision → catalog default → omitted.
Backend outcomes map to the declared fallback with `source: 'default'`:

| Outcome | `reason` |
|---------|----------|
| Maker construction failed (factory throw, missing config) | `no-backend` |
| `DecisionTimeoutError` | `timeout` |
| Any other backend failure or an invalid answer | `error` |
| Confidence below the effective floor (`decision → defaults → 0.7`) | `low-confidence` |
| A confident answer | `accepted` (`source: 'model'`) |

Values: choice returns a string label, score the (possibly fractional) expected score, and noul
`p >= 0.5` with `probability` and confidence `max(p, 1 - p)`. Every result names the selected
`maker`.

## Maker registry

`DecisionMakerRegistry` maps plain names to `DecisionMaker`s — the built-ins above plus anything
consumers register:

```ts
import { createDecisionMaker } from '@gobing-ai/ts-ai-runner';
import { DecisionMakerRegistry } from '@gobing-ai/ts-ai-decision';
import { createClefDriver } from '@gobing-ai/ts-decision-clef';

const registry = new DecisionMakerRegistry(); // pass `builtins: false` to start empty
registry.register('clef', () =>
    createDecisionMaker({ driver: createClefDriver({ accountId, apiToken }) }),
);

registry.has('fm-local');                          // true — nothing was constructed yet
const maker = await registry.resolve('fm-local');  // factory runs here, once, and is memoised
registry.names();                                  // ['typesafe', 'fm-local', 'laya-local', 'llm-agent', 'clef']
```

Registering builds nothing; the first `resolve` runs a factory and memoises the maker, and a
factory that throws is not memoised, so a later `resolve` retries. Invalid or duplicate names
throw `DecisionRegistryError`; unknown names throw `UnknownDecisionMakerError { name }`; factory
errors propagate unchanged. Pass `builtins: { makerOptions, driverOptions }` to tune the
built-ins (env/keys/timeouts via `makerOptions`; executor/client injection via
`driverOptions['fm-local']` / `driverOptions['laya-local']` / `driverOptions['llm-agent']`).

### Configuring `llm-agent`

`llm-agent` turns any installed coding agent or model into a decision model. It samples the agent
`k` times per ask, enum-checks every sample against the question's declared options, and reports
empirical sample frequencies — the agent is never asked for a confidence (ADR-030).

```ts
import { createAgentDriver } from '@gobing-ai/ts-ai-decision';
import { createDecisionMaker } from '@gobing-ai/ts-ai-runner';

const registry = new DecisionMakerRegistry({
    builtins: {
        driverOptions: { 'llm-agent': { agent: 'claude', model: 'haiku', samples: 3 } },
    },
});
// Extra instances under their own names, e.g. a cheap second opinion:
registry.register('llm-haiku', () =>
    createDecisionMaker({ driver: createAgentDriver({ agent: 'claude', model: 'haiku' }) }),
);
```

| Option | Default | Meaning |
|--------|---------|---------|
| `agent` | first installed agent in `TIER1_PRIORITY` | Agent to sample. A configured agent is used as-is with no probe; a missing CLI then fails the sample. |
| `model` | agent default | Model id forwarded to the agent; a per-ask `model` overrides it. |
| `samples` | `3` | Agent invocations per ask — **cost is k runs per ask**, and answer resolution is 1/k. |
| `deterministic` | `false` | One greedy sample; probabilities are one-hot. |
| `concurrency` | `1` | Max samples in flight (sequential by default). |
| `timeoutMs` | `120000` | Budget for one sample; expiry raises `DecisionTimeoutError`. |

**Isolation.** Every ask samples in a fresh scratch directory under the runtime temp dir, removed
when the ask ends — success or failure. This is load-bearing, not tidiness: the claude one-shot shim
grants `--permission-mode acceptEdits --allowedTools Write Edit`, so the scratch directory is what
stops a decision from editing the caller's workspace. The driver never passes `continue`, `sessionId`
or `sessionDir`.

**Availability.** Detection runs on the first `ask` (never at registration), so an agent installed
later is picked up without rebuilding the maker; no agent at all raises `DecisionConfigError` with
code `AGENT`, which the hub reports as `reason: 'no-backend'` so the decision uses its fallback.

`dispose(name?)` releases the resources of already-`resolve`d makers — a `laya-local` maker holds
a warm Python worker whose open pipes keep the calling process alive until it is closed
(reachable from a hub as `hub.registry.dispose()`). It never runs an unresolved factory just to
close it, ignores unknown names, and returns each entry to its unresolved state, so a later
`resolve` builds a fresh maker instead of handing back a closed one.

The same registry can be handed to `createDecisionHub({ registry })` or extended through
`createDecisionHub({ makers: { name: factory } })`.

## Adding a decision backend

New backends follow the existing pattern rather than landing inside this package:

1. Implement `DecisionDriver` from `@gobing-ai/ts-ai-runner` in its own package
   (`packages/decision-<name>`, published as `@gobing-ai/ts-decision-<name>`). Depend only on the
   contract (and ts-runtime / ts-infra seams for platform or HTTP access); never import
   `@gobing-ai/ts-ai-decision`.
2. Return answers that pass `validateAnswers`, translate every transport failure into the
   `Decision*Error` taxonomy, and never invent a confidence the backend does not produce
   (ADR-030: sampled backends report empirical frequencies only).
3. Make it reachable by name: consumers register it (`clef` pattern), or — when it should be
   available out of the box — add a lazy built-in to `DecisionMakerRegistry` with its options
   under `builtins.driverOptions`.
4. Add the boundary to `.spur/rules/typescript/decision-boundaries.yaml` and an ADR entry in
   `docs/00_ADR.md`.

Capabilities every maker benefits from (routing, fallback, catalog features, registry
lifecycle) belong in this package.

## TypeSafe driver

`createTypesafeDriver(config)` ships here since task 0116 (ADR-039): `@gobing-ai/ts-ai-runner` keeps
only the neutral contract, so the driver and the pinned `@typesafe-ai/sdk` (0.7.0) live in this
package.

```ts
import { createTypesafeDriver } from '@gobing-ai/ts-ai-decision';
import { createDecisionMaker } from '@gobing-ai/ts-ai-runner';

const decisions = createDecisionMaker({ driver: createTypesafeDriver({ apiKey }) });
```

`createDecisionMaker({ backend: 'typesafe' })` and the implicit default still resolve the same driver
through a deprecated dynamic-import bridge in `ts-ai-runner` for one release; that path requires this
package to be installed and reports `DecisionConfigError` (`TYPESAFE_BACKEND`) with an install hint
when it is not. `resolveApiKey` remains in `ts-ai-runner` and is what both paths use, so
`TYPESAFE_API_KEY` precedence is unchanged.

`@typesafe-ai/sdk` 0.7.0 raises its Node floor to 22 and compresses request bodies with zstd on
runtimes that support it (Bun does).

## References

- `docs/design/ai-decision-catalog.md` — full catalog field reference, hub and registry design.
- `docs/00_ADR.md` — ADR-027/028 (Laya), ADR-029/030/031 (fm), ADR-033 (catalog + hub),
  ADR-037 (Clef), ADR-038/039 (llm-agent, TypeSafe relocation).
