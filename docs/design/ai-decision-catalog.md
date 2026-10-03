# AI decision catalog and hub (`ts-ai-decision`)

Declarative layer over the `DecisionMaker` surface in `@gobing-ai/ts-ai-runner`
([decision-maker.md](decision-maker.md)). A YAML **catalog** declares named, static decision points
whose shape follows TypeSafe AI's Jev question spec (`type` / `instructions` / `criteria`); a
**`DecisionHub`** loads catalogs and serves `decide(id, input)` with a fallback-guaranteed answer.
A **`DecisionMakerRegistry`** maps maker names to `DecisionMaker`s. It comes with the three bundled
makers, consumers can register their own, and any decision can be routed to a maker by name.
Status: accepted design — ADR-033; not yet built.

Feature: [N](../features/N_declarative-ai-decision-catalog-and-hub-in-ts-ai-decision.md).

## Package

| Item | Value |
|------|-------|
| Name / source | `@gobing-ai/ts-ai-decision` / `packages/ai-decision` |
| Dependencies (`workspace:*`) | `ts-ai-runner` (neutral surface + `typesafe` / Jev), `ts-decision-fm` (`fm-local`), `ts-laya-mlx` (`laya-local`), `ts-runtime` |
| Other dependencies | `zod` |
| Shipped files | `dist`, `src`, `schemas/decision-catalog.schema.json`, `README.md` |
| Exports | `.`, `./schemas/*` and `./package.json`. ts-runtime resolves a `$schema` package specifier through `<pkg>/package.json`, which Bun allows without an export but Node's `require.resolve` rejects (`ERR_PACKAGE_PATH_NOT_EXPORTED`). `./schemas/*` lets editors and other standard resolvers reach the schema directly. rule-engine got the same two exports. |

All three bundled makers are registered by default under their `ts-ai-runner` backend names
(§ Maker registry). The registry builds the `fm-local` and `laya-local` drivers from its own direct
dependencies (`createFmDriver` / `createLayaDriver`) and passes them as
`createDecisionMaker({ driver })`. It therefore does not rely on `ts-ai-runner`'s optional runtime
import of those packages resolving in the consumer's install. The edge is ai-decision → driver →
ai-runner, which ADR-028 allows. Driver modules spawn nothing at import time; platform checks run at
driver construction, and a construction failure becomes a `no-backend` fallback.

Catalog files are **YAML only** (`.yaml` / `.yml`), so authors can comment decisions. The loader
rejects other extensions. Parsing and `$schema` validation reuse `ts-runtime`'s
`parseStructuredConfig` (`packages/runtime/src/schema-validation.ts:74`), so the package adds no
YAML dependency and no platform-API import.

## Catalog file

```yaml
# yaml-language-server: $schema=../node_modules/@gobing-ai/ts-ai-decision/schemas/decision-catalog.schema.json
$schema: "@gobing-ai/ts-ai-decision/schemas/decision-catalog.schema.json"
version: 1
defaults:                       # optional; every key optional
  maker: typesafe               # a registered maker name (built-ins: typesafe | fm-local | laya-local)
  model: jev-latest             # forwarded as the ask-level model; omit for the backend default
  minConfidence: 0.7            # 0..1; package default 0.7 when absent everywhere

decisions:
  category:
    type: choice
    description: Route an inbound support ticket   # documentation only; never sent to the model
    instructions: "Classify this ${params.channel} ticket: ${params.instructions}"
    parameters:
      channel: { type: enum, values: [email, chat], default: email }
    criteria:                   # label -> description (null = undescribed); >= 2 labels
      bug_report: The user is reporting something that is broken or producing errors
      billing: Charges, invoices, refunds, subscriptions
      feature_request: The user is requesting new functionality
      account: Login, permissions, profile, security
    fallback: account           # must be a criteria label

  bug_severity:
    type: score
    parameters:
      component: string         # shorthand: type only -> required
      affected_users: { type: number, default: 10 }
    # no `instructions` key -> defaults to "${params.instructions}"
    criteria:                   # ordered rubric, index = level; >= 2 entries
      - Cosmetic; no impact to functionality
      - Broken or degraded feature in ${params.component}; workaround exists
      - Blocking issue; no workaround exists
    fallback: 1                 # integer level in [0, criteria.length - 1]
    maker: laya-local           # per-decision override

  refund_requested:
    type: noul
    criteria:                   # optional; Jev keys
      true: The customer explicitly asks for money back
      false: Anything else
    fallback: false             # boolean
    minConfidence: 0.8
```

### Field reference (normative)

Top level:

| Key | Required | Type | Notes |
|-----|----------|------|-------|
| `$schema` | no | string | Bundled package-specifier ref; validated when present |
| `version` | yes | `1` | Catalog format version |
| `defaults` | no | `{ maker?, model?, minConfidence? }` | Catalog-wide defaults |
| `decisions` | yes | map id → decision (≥ 1) | Ids match `^[a-z][a-z0-9_-]*$` |

Decision:

| Key | Required | Type | Notes |
|-----|----------|------|-------|
| `type` | yes | `choice` \| `score` \| `noul` | Jev question type |
| `description` | no | string | Documentation and `describe()` only |
| `instructions` | no | Jev entry: string, JSON object or array | Templated. Defaults to `"${params.instructions}"` |
| `parameters` | no | map name → param | Names match `^[a-z][a-zA-Z0-9_]*$`; `instructions` is reserved |
| `criteria` | choice: yes; score: yes; noul: no | choice: map label → entry\|null (≥ 2); score: list of entry\|null (≥ 2); noul: `{ true?, false? }` | Description strings are templated; labels are not |
| `fallback` | yes | choice: a label; score: integer level; noul: boolean | Required, so `decide` always has a concrete answer |
| `minConfidence` | no | number 0..1 | Overrides `defaults.minConfidence` |
| `maker` | no | maker name, `^[a-z][a-z0-9-]*$` | Overrides `defaults.maker`. It must be registered when the catalog is loaded into a hub |
| `model` | no | string | Overrides `defaults.model` |

Unknown keys are rejected at every level (`additionalProperties: false` / zod `.strict()`).

### Parameters

A parameter is either the shorthand `name: <type>` or the full form
`name: { type, default?, values?, description? }`.

| `type` | Accepted input | Substitutes as |
|--------|----------------|----------------|
| `string` | string | verbatim |
| `number` | finite number | `String(n)` |
| `boolean` | boolean | `"true"` / `"false"` |
| `enum` | one of `values` (strings, ≥ 1) | verbatim |
| `json` | any JSON value | `JSON.stringify(v)` |

- **Required means no default.** A parameter with a `default` key is optional; one without (including
  every shorthand) is required. `default: null` makes a parameter optional with no value; it
  substitutes as `""` and is omitted from the state.
- `default` must match the declared type, and for `enum` must be one of `values` (checked at load).
- Unknown input keys are rejected. The parameter list plus `instructions` is the whole input
  contract.

### The reserved `instructions` parameter

Every decision implicitly has an optional `instructions` parameter: type `string`, default `""`.
It carries the end user's or external system's text for the model to evaluate. Authors cannot
declare it under `parameters`; that is a load error.

- With no authored `instructions` key, the Jev question's `instructions` is the caller's text,
  passed through unchanged.
- An authored `instructions` template embeds it with `${params.instructions}` beside other
  parameters.

### Variable replacement

The syntax matches `ts-dual-workflow-engine`'s `${namespace.key}` resolver
(`packages/dual-workflow-engine/src/variables.ts`), with a single namespace, `params`.

- **Where:** every string leaf of `instructions` and of `criteria` descriptions, recursing into JSON
  objects and arrays. Criteria labels, `fallback`, `maker` and `model` are never templated, so the
  answer vocabulary stays static.
- **What:** `${params.<name>}`, where `<name>` is a declared parameter or `instructions`.
  Substitution happens once per `decide`, before the backend call.
- **Load-time check:** a `${...}` reference to an undeclared parameter, or to any other namespace,
  fails the load. In particular `${env.X}` is rejected, so environment values and secrets can
  never reach a prompt.
- **No escaping:** no escape syntax is needed until someone requires a literal `${params.…}`.

### Request mapping (Jev)

One `decide` call sends exactly one question, through the neutral surface:

| Jev request field | Value |
|-------------------|-------|
| `state` | Resolved declared parameters (excluding `instructions` and null values) as a JSON object; `null` when none |
| `questions` | `{ [decisionId]: { type, instructions: <rendered>, criteria: <rendered> } }` |
| `model` | Decision `model` → `defaults.model` → omitted |

The neutral surface maps the fields itself: `q.choice(prompt, labels)`, `q.score(prompt, rubric)`,
and `q.noul(prompt, { yes: criteria.true, no: criteria.false })`. The driver turns these back into
the Jev wire format, so the catalog never touches the SDK.

### Load-time checks (fail loud, all-or-nothing per catalog)

1. Extension is `.yaml` / `.yml`. The YAML parses with unique keys. The JSON Schema passes (when
   `$schema` is present). The zod schema passes.
2. `fallback` is in the type's vocabulary: a declared label, an integer level within the rubric, or
   a boolean.
3. Every `${...}` reference is `${params.<declared or instructions>}`.
4. Every `default` matches its type and enum `values`. No parameter is named `instructions`.
5. In a hub, decision ids are unique across all loaded catalogs, and every `maker` name
   (decision or `defaults`) is registered in the hub's registry. The loader alone is
   registry-agnostic, so this check runs in `hub.load`.

Violations throw `DecisionCatalogError { source, decisionId?, field?, message }`, and a failing
catalog registers nothing.

## Deviations from the starting sample

| Sample | Fixed schema | Why |
|--------|--------------|-----|
| `kind:` on one decision, `type:` on others | `type:` everywhere | One key; `type` is Jev's wire name, so a decision reads as a Jev question plus extras |
| Repeated `default:` keys under `parameters` | `name: <type>` or `name: { type, default }` | The sample is invalid YAML. `yaml` rejects it with `Map keys must be unique` |
| Decision ids at the top level | Under `decisions:` | Leaves room for `$schema`, `version` and `defaults` without colliding with an id |
| No fallback | `fallback` required | The "concrete and solid response" guarantee needs a declared answer when the model cannot give one |
| No question text | Optional templated `instructions` (defaults to the caller's `instructions`) | Uses Jev's own field name. Authors can wrap caller text with context |
| noul without criteria | Optional `criteria: { true, false }` | Jev's wire keys; YAML parses them as string keys |
| — | `maker:` names a registered DecisionMaker | One string picks a built-in or consumer-registered maker |

## API

```ts
export function loadDecisionCatalog(path: string, options?: CatalogLoadOptions): Promise<DecisionCatalog>;
export function parseDecisionCatalog(content: string, source: string, options?: CatalogLoadOptions): Promise<DecisionCatalog>;

export interface CatalogLoadOptions {
    validateSchema?: boolean;                    // default true — honour top-level $schema
    fileSystem?: Pick<FileSystem, 'readFile'>;   // ts-runtime FileSystem; default createNodeFileSystem()
}

/** A maker, or a lazy factory for one. Factories run on first use and are memoised on success. */
export type MakerSource = DecisionMaker | (() => DecisionMaker | Promise<DecisionMaker>);

export interface BuiltinMakerOptions {
    /** Forwarded to createDecisionMaker for every built-in (env, apiKey, baseURL, timeoutMs, ...). */
    makerOptions?: Omit<DecisionMakerOptions, 'driver' | 'backend' | 'model'>;
    /** Driver options for the bundled local drivers. */
    driverOptions?: { 'fm-local'?: FmDriverOptions; 'laya-local'?: LayaDriverOptions };
}

export class DecisionMakerRegistry {
    /** Pre-registers typesafe, fm-local and laya-local unless `builtins: false`. */
    constructor(options?: { builtins?: BuiltinMakerOptions | false });
    register(name: string, source: MakerSource): this;   // DecisionRegistryError: bad name or already registered
    has(name: string): boolean;
    names(): string[];
    resolve(name: string): Promise<DecisionMaker>;        // UnknownDecisionMakerError; factory errors propagate, not memoised
}

export interface DecisionHubOptions {
    registry?: DecisionMakerRegistry;   // default new DecisionMakerRegistry()
    defaultMaker?: string;              // used when neither decision nor catalog names a maker; default 'typesafe'
    now?: () => number;                 // clock for durationMs; default Date.now
}

export interface DecideOptions {
    maker?: string;                     // per-call maker name; wins over catalog and hub defaults
}

export class DecisionHub {
    constructor(options?: DecisionHubOptions);  // UnknownDecisionMakerError when defaultMaker is unregistered
    readonly registry: DecisionMakerRegistry;
    load(catalog: DecisionCatalog): void;           // DecisionCatalogError: duplicate id or unregistered maker
    loadFile(path: string, options?: CatalogLoadOptions): Promise<void>;
    list(): DecisionSummary[];                       // { id, type, description, source }
    describe(id: string): DecisionDescriptor;        // parameters (incl. instructions), criteria, fallback, minConfidence, maker, model
    decide(id: string, input?: Record<string, Json>, options?: DecideOptions): Promise<DecisionResult>;
}

/** One call from config to a ready hub: build the registry, register `makers`, then load `catalogs` in order. */
export function createDecisionHub(options?: DecisionHubOptions & {
    builtins?: BuiltinMakerOptions | false;          // ignored when `registry` is supplied
    makers?: Record<string, MakerSource>;
    catalogs?: string[];
    catalogOptions?: CatalogLoadOptions;
}): Promise<DecisionHub>;

export type DecisionResult =
    | (ResultBase & { type: 'choice'; value: string })
    | (ResultBase & { type: 'score'; value: number })        // expected score; may fall between levels
    | (ResultBase & { type: 'noul'; value: boolean; probability: number | null });

interface ResultBase {
    id: string;
    confidence: number | null;      // null only when no answer was obtained
    source: 'model' | 'default';
    reason: 'accepted' | 'low-confidence' | 'no-backend' | 'timeout' | 'error';
    maker: string;                  // registry name that was selected
    durationMs: number;
}
```

`describe` and `list` never construct a `DecisionMaker` or driver.

Typical consumer:

```ts
const hub = await createDecisionHub({
    catalogs: ['decisions/support.yaml'],
    makers: { 'scripted-judge': () => createDecisionMaker({ driver: myDriver }) },
});
const r = await hub.decide('category', { instructions: ticketText, channel: 'chat' });
const r2 = await hub.decide('category', { instructions: ticketText }, { maker: 'fm-local' });
```

## Maker registry

- **Names** match `^[a-z][a-z0-9-]*$`. Registering a name twice throws `DecisionRegistryError`.
  To configure a built-in differently, pass `builtins` options or start from `builtins: false` and
  register your own.
- **Built-ins:**
  - `typesafe` → `createDecisionMaker({ backend: 'typesafe', ...makerOptions })`
  - `fm-local` → `createDecisionMaker({ driver: createFmDriver(driverOptions['fm-local'] ?? {}), ...makerOptions })`
  - `laya-local` → the same with `createLayaDriver`
- **Laziness:** a factory runs on the first `resolve` and its maker is memoised. A failed factory is
  not memoised, so a later call retries. Registering never builds anything.
- **Sharing:** one registry can back several hubs. The registry is generic and does not depend on
  catalogs, so code without a catalog can use it to pick makers by name.

## `decide` algorithm

1. An unknown id throws `UnknownDecisionError`, and an unregistered per-call maker throws
   `UnknownDecisionMakerError`. Input that breaks the parameter contract throws
   `DecisionInputError { decisionId, param, message }`. Neither case makes a backend call.
2. Resolve parameters: declared defaults, overlaid by input, plus `instructions` (default `""`).
3. Render `instructions` and `criteria` (§ Variable replacement), then build one question of the
   declared type.
4. Select the maker name: per-call `options.maker`, then the decision's `maker`, then the catalog's
   `defaults.maker`, then the hub's `defaultMaker` (default `typesafe`). A per-call name that is not
   registered throws `UnknownDecisionMakerError` before any backend call; it is a caller error.
   Catalog names were already checked at load. `registry.resolve(name)` builds lazily, and a
   factory or construction failure is a `no-backend` outcome, not a throw.
5. `maker.ask({ state, questions: { [id]: question }, model })`, with exactly one question per call.
6. Confidence and value:
   - choice / score: `confidence` comes from the answer.
   - noul: `p` is the yes-probability, `confidence = max(p, 1 - p)`, and the value is `p >= 0.5`.

   Below the effective `minConfidence` (decision, then `defaults`, then 0.7), return the fallback
   with `low-confidence`.
7. Errors from steps 4–5 resolve to the fallback:
   - `DecisionConfigError` → `no-backend`
   - `DecisionTimeoutError` → `timeout`
   - any other error, including an invalid answer reported as `DecisionBackendError` → `error`

Fallback results carry `source: 'default'`, the declared fallback `value`, and whatever
`confidence` was observed (null when none), and always the selected `maker` name. `decide` never rejects for steps 4–7.

## Non-goals

These are out of scope (see feature N `### Out of scope`):

- network transport, caching, and batching several decisions into one request
- persistence
- call-time (dynamic) questions
- JSON catalogs
- template logic beyond `${params.*}` substitution
