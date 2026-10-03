# @gobing-ai/ts-ai-decision

Declarative YAML **decision catalogs** over the `DecisionMaker` surface of
`@gobing-ai/ts-ai-runner`, served through a fallback-guaranteed **`DecisionHub`** (ADR-033). A
catalog declares named, static decision points whose shape follows TypeSafe AI's Jev question
spec (`type` / `instructions` / `criteria`), with a required `fallback` so every decision always
has a concrete answer.

The package owns three layers: the strict catalog schema and loader (JSON Schema + zod,
`${params.*}` template validation/rendering, load-time consistency checks), the
`DecisionMakerRegistry` (makers picked by name), and the `DecisionHub` (one Jev question per
`decide`, declared fallback on every backend outcome).

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

`DecisionHub` loads catalogs and serves `decide(id, input)` with a guaranteed concrete answer —
see `examples/decisions.yaml` for a complete catalog:

```ts
import { DecisionHub } from '@gobing-ai/ts-ai-decision';

const hub = new DecisionHub();                 // registry with the built-ins, defaultMaker 'typesafe'
await hub.loadFile('decisions/support.yaml');  // or hub.load(loadedCatalog)

hub.list();                                    // [{ id, type, description, source }] — pure discovery
hub.describe('category');                      // parameters (incl. instructions), criteria, fallback,
                                               // effective minConfidence, maker and model
const r = await hub.decide('category', { instructions: ticketText, channel: 'chat' });
// { id, type, value, confidence, source, reason, maker, durationMs }
const r2 = await hub.decide('category', { instructions: ticketText }, { maker: 'fm-local' });
```

`load` is all-or-nothing per catalog: a duplicate decision id across catalogs, or a `maker`
name (decision or `defaults.maker`) that is not registered, throws `DecisionCatalogError` and
registers nothing from the offending catalog. `list` and `describe` never construct a maker or
driver.

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

`DecisionMakerRegistry` maps plain names to `DecisionMaker`s — the three built-ins (`typesafe`,
`fm-local`, `laya-local`) pre-registered lazily, plus anything consumers register (ADR-033):

```ts
import { createDecisionMaker } from '@gobing-ai/ts-ai-runner';
import { DecisionMakerRegistry } from '@gobing-ai/ts-ai-decision';

const registry = new DecisionMakerRegistry(); // pass `builtins: false` to start empty
registry.register('scripted-judge', () => createDecisionMaker({ driver: myDriver }));

registry.has('fm-local');                          // true — nothing was constructed yet
const maker = await registry.resolve('fm-local');  // factory runs here, once, and is memoised
registry.names();                                  // ['typesafe', 'fm-local', 'laya-local', 'scripted-judge']
```

Registering builds nothing; the first `resolve` runs a factory and memoises the maker, and a
factory that throws is not memoised, so a later `resolve` retries. Invalid or duplicate names
throw `DecisionRegistryError`; unknown names throw `UnknownDecisionMakerError { name }`; factory
errors propagate unchanged. Pass `builtins: { makerOptions, driverOptions }` to tune the built-ins
(env/keys/timeouts, or executor/client injection for the local drivers).

The hub picks a maker purely by name — no new driver code per routing:
per-call `options.maker` → the decision's `maker` → the catalog's `defaults.maker` → the hub's
`defaultMaker` (default `typesafe`). Catalog names are checked at `load`; a misspelled per-call
name fails loudly instead of falling back. `createDecisionHub` composes the whole thing in one
call and never returns a partially built hub:

```ts
import { createDecisionHub } from '@gobing-ai/ts-ai-decision';

const hub = await createDecisionHub({
    catalogs: ['decisions/support.yaml'],
    makers: { 'scripted-judge': () => createDecisionMaker({ driver: myDriver }) },
});
```

See `docs/design/ai-decision-catalog.md` for the full field reference.
