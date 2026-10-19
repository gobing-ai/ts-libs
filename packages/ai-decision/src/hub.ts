import {
    type Answer,
    DecisionConfigError,
    type DecisionState,
    DecisionTimeoutError,
    type Json,
    type Question,
    q,
    validateAnswers,
} from '@gobing-ai/ts-ai-runner';
import { type CatalogLoadOptions, loadDecisionCatalog } from './catalog';
import { DecisionCatalogError, UnknownDecisionError, UnknownDecisionMakerError } from './errors';
import { buildState, renderQuestion, resolveDecisionInput } from './params';
import { type BuiltinMakerOptions, DecisionMakerRegistry, type MakerSource } from './registry';
import type {
    CatalogDefaults,
    DecisionCatalog,
    DecisionCriteria,
    DecisionDefinition,
    DecisionParam,
    DecisionType,
    JevEntry,
    JevQuestion,
    MakerRef,
} from './types';

/**
 * DecisionHub (task 0090, ADR-033 § API / § decide algorithm): loads catalogs
 * over the 0089 loader and serves `decide` through makers resolved by name
 * from the 0091 registry. `decide` never rejects for backend construction,
 * transport, timeout, answer validation or low confidence — it maps every such
 * outcome to the declared fallback — and rejects only for caller mistakes
 * (unknown id, invalid input, unregistered per-call maker), always before any
 * backend call. The hub contains no driver code; every maker comes from
 * `registry.resolve(name)`.
 */

/** Package confidence floor when neither the decision nor the catalog declares one. */
export const DEFAULT_MIN_CONFIDENCE = 0.7;

/** Hub default when neither the per-call options, the decision nor the catalog names a maker. */
export const DEFAULT_MAKER = 'typesafe';

/** Upper bound on a carried error message, in characters (ADR-040). */
export const DECISION_ERROR_MESSAGE_MAX = 500;

/**
 * The caught failure, carried on a fallback result so a consumer can persist it (Spur stores
 * `decision_logs.error`). Only `name` and `message`: a stack, a `cause` chain or the failing
 * request would leak prompt text and internals into logs.
 */
export interface DecisionErrorInfo {
    readonly name: string;
    readonly message: string;
}

/**
 * Reduce a thrown value to {@link DecisionErrorInfo}. Subclasses of `DecisionError` set their own
 * `name`; a subclass that does not is named by its constructor rather than by `'Error'`.
 */
function toErrorInfo(error: unknown): DecisionErrorInfo {
    if (!(error instanceof Error)) {
        return { name: 'NonError', message: String(error).slice(0, DECISION_ERROR_MESSAGE_MAX) };
    }
    const named = error.name !== 'Error' ? error.name : (error.constructor?.name ?? error.name);
    return { name: named, message: error.message.slice(0, DECISION_ERROR_MESSAGE_MAX) };
}

/**
 * One maker's attempt inside a chain: what it was, how it ended, and how long it took. Present only
 * when more than one maker was tried, so a single-name decision's result is unchanged.
 */
export interface DecisionAttempt {
    readonly maker: string;
    readonly reason: DecisionResultBase['reason'];
    readonly durationMs: number;
    readonly error?: DecisionErrorInfo;
}

/**
 * What a shadow maker did with the same request. Observed only: it rides beside the served answer and
 * never changes it (ADR-040). `value` is the answer the shadow itself produced, so it is absent when
 * the shadow fell back.
 */
export interface ShadowOutcome {
    readonly maker: string;
    readonly value?: string | number | boolean;
    readonly confidence: number | null;
    readonly reason: DecisionResultBase['reason'];
    readonly durationMs: number;
    readonly error?: DecisionErrorInfo;
}

/** Shared envelope of every {@link DecisionResult} variant. */
export interface DecisionResultBase {
    readonly id: string;
    /** Observed calibration; null only when no answer was obtained. */
    readonly confidence: number | null;
    /** `model` for an accepted answer, `default` for any fallback. */
    readonly source: 'model' | 'default';
    readonly reason: 'accepted' | 'low-confidence' | 'no-backend' | 'timeout' | 'error';
    /** Registry name of the maker that was selected. */
    readonly maker: string;
    readonly durationMs: number;
    /** The caught failure. Present only for `no-backend`, `timeout` and `error`. */
    readonly error?: DecisionErrorInfo;
    /** Every maker tried, in order. Present only when a chain tried more than one. */
    readonly attempts?: readonly DecisionAttempt[];
    /** The shadow's outcome. Present only when the decision or the call named a shadow. */
    readonly shadow?: ShadowOutcome;
}

/** The fallback-guaranteed result of one `decide` call, shaped by the decision type. */
export type DecisionResult =
    | (DecisionResultBase & { readonly type: 'choice'; readonly value: string })
    | (DecisionResultBase & { readonly type: 'score'; readonly value: number })
    | (DecisionResultBase & { readonly type: 'noul'; readonly value: boolean; readonly probability: number | null });

/** One loaded decision, for downstream discovery (`hub.list()`). */
export interface DecisionSummary {
    readonly id: string;
    readonly type: DecisionType;
    readonly description?: string;
    readonly source: string;
}

/** Full served contract of one decision (`hub.describe(id)`), including the effective defaults. */
export interface DecisionDescriptor {
    readonly id: string;
    readonly type: DecisionType;
    readonly description?: string;
    readonly source: string;
    /** Declared parameter contract including the reserved `instructions` parameter. */
    readonly parameters: Readonly<Record<string, DecisionParam>>;
    readonly criteria: DecisionCriteria;
    readonly fallback: string | number | boolean;
    /** decision → catalog defaults → {@link DEFAULT_MIN_CONFIDENCE}. */
    readonly minConfidence: number;
    /** First name of the effective chain (decision → catalog defaults → hub defaultMaker). */
    readonly maker: string;
    /** The full effective chain; a single name yields a one-element list. */
    readonly makers: readonly string[];
    /** The decision's configured shadow; a per-call shadow is not visible to `describe`. */
    readonly shadow?: string;
    /** decision → catalog defaults; absent when neither declares one. */
    readonly model?: string;
}

/** {@link DecisionHub} construction options. */
export interface DecisionHubOptions {
    /** Default: a fresh `DecisionMakerRegistry` with the three built-in makers. */
    readonly registry?: DecisionMakerRegistry;
    /** Used when neither the decision nor the catalog names a maker. Default 'typesafe'. */
    readonly defaultMaker?: string;
    /** Clock for `durationMs`; injectable so tests are deterministic. Default `Date.now`. */
    readonly now?: () => number;
}

/** Per-call options for {@link DecisionHub.decide}. */
export interface DecideOptions {
    /**
     * Per-call maker name or ordered fallback chain (ADR-040); wins over the decision's, the
     * catalog's and the hub default. Validated before any backend call.
     */
    readonly maker?: MakerRef;
    /** Per-call shadow maker (ADR-040); wins over the decision's. Validated before any backend call. */
    readonly shadow?: string;
}

/**
 * One maker's outcome: its result, whether the chain should advance past it, and the answer it
 * actually produced (absent when it fell back), which a shadow reports as its own value.
 */
interface AskOutcome {
    result: DecisionResult;
    failed: boolean;
    answered?: string | number | boolean;
}

/** The one-question request handed to a maker — the shape of `DecisionMaker.ask`. */
interface AskRequest {
    state: DecisionState;
    questions: Record<string, Question>;
    model?: string;
}

/**
 * Normalize a {@link MakerRef} to an ordered chain. Empty and duplicate lists are caller errors
 * here, not at load: the loader's schema already rejects them in a catalog.
 */
function toChain(ref: MakerRef): readonly string[] {
    if (typeof ref === 'string') return [ref];
    if (ref.length === 0) {
        throw new UnknownDecisionMakerError('A maker chain must name at least one maker', '');
    }
    const seen = new Set<string>();
    for (const name of ref) {
        if (seen.has(name)) {
            throw new UnknownDecisionMakerError(`Maker chain repeats '${name}'`, name);
        }
        seen.add(name);
    }
    return [...ref];
}

/** One registered decision plus the catalog defaults it loaded under. */
interface RegisteredDecision {
    readonly definition: DecisionDefinition;
    readonly defaults: CatalogDefaults;
}

/** Effective confidence floor: decision → catalog defaults → package default. */
function effectiveMinConfidence(definition: DecisionDefinition, defaults: CatalogDefaults): number {
    return definition.minConfidence ?? defaults.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
}

/** Confidence observed in one validated answer; noul synthesizes `max(p, 1 - p)`. */
function observedAnswer(answer: Answer): { confidence: number; probability?: number } {
    switch (answer.kind) {
        case 'choice':
            return { confidence: answer.confidence };
        case 'score':
            return { confidence: answer.confidence };
        case 'noul':
            return {
                confidence: Math.max(answer.probability, 1 - answer.probability),
                probability: answer.probability,
            };
    }
}

/**
 * Map the rendered question onto the neutral Jev builders — exactly one
 * question per `decide` call, keyed by the decision id at the `ask` level.
 */
function buildJevQuestion(question: JevQuestion): Question {
    switch (question.type) {
        case 'choice':
            return q.choice(question.instructions, { ...question.criteria });
        case 'score':
            // The loader enforces >= 2 levels; the tuple is the builder's shape.
            return q.score(question.instructions, question.criteria as readonly [JevEntry, JevEntry, ...JevEntry[]]);
        case 'noul': {
            const outcomes = question.criteria;
            return q.noul(
                question.instructions,
                outcomes !== undefined ? { yes: outcomes.true, no: outcomes.false } : undefined,
            );
        }
    }
}

/**
 * Hub over loaded catalogs and named makers (task 0090, ADR-033 § API):
 * `decide` serves one Jev question per call and resolves every backend outcome
 * to the declared fallback; only caller mistakes throw, before any backend
 * call. Discovery (`list`/`describe`) and maker construction stay decoupled —
 * makers come only from `registry.resolve(name)`.
 */
export class DecisionHub {
    readonly registry: DecisionMakerRegistry;
    private readonly decisions = new Map<string, RegisteredDecision>();
    private readonly defaultMaker: string;
    private readonly now: () => number;

    constructor(options: DecisionHubOptions = {}) {
        this.registry = options.registry ?? new DecisionMakerRegistry();
        this.defaultMaker = options.defaultMaker ?? DEFAULT_MAKER;
        this.now = options.now ?? Date.now;
        if (!this.registry.has(this.defaultMaker)) {
            throw new UnknownDecisionMakerError(
                `Default decision maker '${this.defaultMaker}' is not registered in the hub registry ` +
                    `(registered: ${this.registry.names().join(', ') || 'none'})`,
                this.defaultMaker,
            );
        }
    }

    /**
     * Register every decision of an already-loaded catalog. All-or-nothing: a
     * duplicate decision id or an unregistered maker name (any chain name of a
     * decision or `defaults.maker`, or a decision `shadow`) throws
     * {@link DecisionCatalogError} and registers
     * nothing from the offending catalog.
     */
    load(catalog: DecisionCatalog): void {
        const defaultsMaker = catalog.defaults.maker;
        const defaultsChain = defaultsMaker === undefined ? undefined : toChain(defaultsMaker);
        for (const name of defaultsChain ?? []) {
            if (!this.registry.has(name)) {
                throw new DecisionCatalogError(
                    `Catalog "${catalog.source}" defaults.maker '${name}' is not registered in the hub registry ` +
                        `(registered: ${this.registry.names().join(', ') || 'none'})`,
                    catalog.source,
                    undefined,
                    'maker',
                );
            }
        }
        // Stage first, commit only when every decision passed the cross-catalog checks.
        const staged: RegisteredDecision[] = [];
        for (const [id, definition] of Object.entries(catalog.decisions)) {
            const existing = this.decisions.get(id);
            if (existing !== undefined) {
                throw new DecisionCatalogError(
                    `Decision id "${id}" in catalog "${catalog.source}" duplicates the decision loaded from ` +
                        `"${existing.definition.source}"`,
                    catalog.source,
                    id,
                    'id',
                );
            }
            for (const name of definition.maker === undefined ? [] : toChain(definition.maker)) {
                if (!this.registry.has(name)) {
                    throw new DecisionCatalogError(
                        `Decision "${id}" in catalog "${catalog.source}" names maker '${name}' that is not ` +
                            `registered in the hub registry (registered: ${this.registry.names().join(', ') || 'none'})`,
                        catalog.source,
                        id,
                        'maker',
                    );
                }
            }
            if (definition.shadow !== undefined && !this.registry.has(definition.shadow)) {
                throw new DecisionCatalogError(
                    `Decision "${id}" in catalog "${catalog.source}" names shadow '${definition.shadow}' that is not ` +
                        `registered in the hub registry (registered: ${this.registry.names().join(', ') || 'none'})`,
                    catalog.source,
                    id,
                    'shadow',
                );
            }
            staged.push({ definition, defaults: catalog.defaults });
        }
        for (const entry of staged) this.decisions.set(entry.definition.id, entry);
    }

    /** Load a catalog file through the 0089 loader, then register it via {@link load}. */
    async loadFile(path: string, options: CatalogLoadOptions = {}): Promise<void> {
        this.load(await loadDecisionCatalog(path, options));
    }

    /** Pure read over the loaded decisions; never constructs a maker or driver. */
    list(): DecisionSummary[] {
        return [...this.decisions.values()].map(({ definition }) => ({
            id: definition.id,
            type: definition.type,
            ...(definition.description !== undefined ? { description: definition.description } : {}),
            source: definition.source,
        }));
    }

    /** Pure read of one decision's served contract; throws UnknownDecisionError for an unknown id. */
    describe(id: string): DecisionDescriptor {
        const { definition, defaults } = this.mustGet(id);
        const chain = this.effectiveChain(definition, defaults);
        const model = definition.model ?? defaults.model;
        return {
            id: definition.id,
            type: definition.type,
            ...(definition.description !== undefined ? { description: definition.description } : {}),
            source: definition.source,
            parameters: definition.parameters,
            criteria: definition.criteria,
            fallback: definition.fallback,
            minConfidence: effectiveMinConfidence(definition, defaults),
            maker: chain[0] ?? DEFAULT_MAKER,
            makers: chain,
            ...(definition.shadow !== undefined ? { shadow: definition.shadow } : {}),
            ...(model !== undefined ? { model } : {}),
        };
    }

    /**
     * Serve one decision with a fallback-guaranteed answer. Resolves the input,
     * renders exactly one Jev question keyed by the decision id, selects the
     * maker chain (per call → decision → catalog defaults → hub default) and
     * asks its makers in order until one answers, with an optional shadow asked
     * beside it (ADR-040). Backend construction, transport, timeout,
     * invalid answers and low confidence all resolve to the declared fallback;
     * only caller mistakes throw, before any backend call.
     */
    async decide(id: string, input: Record<string, Json> = {}, options: DecideOptions = {}): Promise<DecisionResult> {
        const start = this.now();
        const { definition, defaults } = this.mustGet(id); // UnknownDecisionError — caller error
        const params = resolveDecisionInput(definition, input); // DecisionInputError — caller error

        const chain = options.maker === undefined ? this.effectiveChain(definition, defaults) : toChain(options.maker);
        for (const name of chain) {
            // Reachable only for a per-call chain: catalog and hub default names are checked at
            // load/construct. A caller error, thrown before any backend interaction.
            if (!this.registry.has(name)) {
                throw new UnknownDecisionMakerError(
                    `Decision "${id}" was asked on maker '${name}' that is not registered in the hub registry ` +
                        `(registered: ${this.registry.names().join(', ') || 'none'})`,
                    name,
                );
            }
        }

        const shadowName = options.shadow ?? definition.shadow;
        if (shadowName !== undefined && !this.registry.has(shadowName)) {
            // Same caller-error rule as a per-call maker name: before any backend interaction.
            throw new UnknownDecisionMakerError(
                `Decision "${id}" was asked with shadow '${shadowName}' that is not registered in the hub registry ` +
                    `(registered: ${this.registry.names().join(', ') || 'none'})`,
                shadowName,
            );
        }

        const state: DecisionState = buildState(definition, params);
        const model = definition.model ?? defaults.model;
        const request = {
            state,
            questions: { [definition.id]: buildJevQuestion(renderQuestion(definition, params)) },
            ...(model !== undefined ? { model } : {}),
        };

        // Shadow rule (ADR-040): start the shadow on the SAME request object, without awaiting it, so
        // both paths run concurrently and latency is the slower of the two. It never rejects `decide`
        // and never touches a served field — a rejected or failed ask maps to its own outcome.
        const shadowStart = this.now();
        const shadowTask: Promise<AskOutcome> | undefined =
            shadowName === undefined
                ? undefined
                : this.askOne(shadowName, definition, defaults, request, shadowStart).then(
                      (settled): AskOutcome => settled,
                      (error: unknown): AskOutcome => ({
                          result: this.fallbackResult(
                              definition,
                              shadowName,
                              'error',
                              null,
                              shadowStart,
                              undefined,
                              toErrorInfo(error),
                          ),
                          failed: true,
                      }),
                  );

        // Chain rule (ADR-040): ask makers in order and stop at the first that did not fail as a
        // backend — `accepted` and `low-confidence` both answer. Every maker after the answering one
        // stays unresolved, so its lazy factory never runs.
        const attempts: DecisionAttempt[] = [];
        let last: { result: DecisionResult; failed: boolean } | undefined;
        for (const makerName of chain) {
            const attemptStart = this.now();
            last = await this.askOne(makerName, definition, defaults, request, attemptStart);
            attempts.push({
                maker: makerName,
                reason: last.result.reason,
                durationMs: this.now() - attemptStart,
                ...(last.result.error !== undefined ? { error: last.result.error } : {}),
            });
            if (!last.failed) break;
        }

        // `toChain` rejects an empty list, so the loop always ran at least once.
        const final = last?.result;
        if (final === undefined) {
            throw new UnknownDecisionMakerError(`Decision "${id}" has no maker to ask`, id);
        }
        // `durationMs` covers the whole call, shadow wait included; a single-maker call without a
        // shadow keeps its exact previous shape.
        const shadowOutcome = shadowTask === undefined ? undefined : this.toShadowOutcome(await shadowTask);
        return {
            ...final,
            durationMs: this.now() - start,
            ...(attempts.length > 1 ? { attempts } : {}),
            ...(shadowOutcome !== undefined ? { shadow: shadowOutcome } : {}),
        };
    }

    /**
     * Project a shadow's own result onto {@link ShadowOutcome}. `value` is carried only when the shadow
     * actually answered — a served-model answer or a low-confidence one — never its declared fallback.
     */
    private toShadowOutcome(outcome: AskOutcome): ShadowOutcome {
        const { result } = outcome;
        const answered = result.source === 'model' || result.reason === 'low-confidence';
        return {
            maker: result.maker,
            ...(answered && outcome.answered !== undefined ? { value: outcome.answered } : {}),
            confidence: result.confidence,
            reason: result.reason,
            durationMs: result.durationMs,
            ...(result.error !== undefined ? { error: result.error } : {}),
        };
    }

    /**
     * Ask one maker and classify its outcome. `failed` is true exactly for `no-backend`, `timeout`
     * and `error` — the reasons a chain advances past (ADR-040); `accepted` and `low-confidence`
     * answer, so the chain stops there.
     */
    private async askOne(
        makerName: string,
        definition: DecisionDefinition,
        defaults: CatalogDefaults,
        request: AskRequest,
        start: number,
    ): Promise<AskOutcome> {
        const outcome = (result: DecisionResult, answered?: string | number | boolean): AskOutcome => ({
            result,
            failed: result.reason === 'no-backend' || result.reason === 'timeout' || result.reason === 'error',
            ...(answered !== undefined ? { answered } : {}),
        });

        // The one auditable try/catch for steps 4–5: a resolve failure is a construction
        // failure (no-backend); ask failures map per the error taxonomy. Neither rejects.
        let inAsk = false;
        try {
            const maker = await this.registry.resolve(makerName);
            inAsk = true;
            const answers = await maker.ask(request);
            // Every resolved maker crosses the shared validator — a directly registered maker would
            // otherwise skip the check createDecisionMaker applies. Inside the try: its
            // DecisionBackendError is an answer failure, never a caller error.
            validateAnswers(request.questions, answers);
            const answer: Answer | undefined = answers[definition.id];
            if (answer === undefined || answer.kind !== definition.type) {
                // Nothing was thrown here, so the failure is synthesized: every `error` reason
                // must carry a cause a consumer can log (ADR-040).
                return outcome(
                    this.fallbackResult(definition, makerName, 'error', null, start, undefined, {
                        name: 'DecisionBackendError',
                        message: `Maker returned no answer of type ${definition.type} for "${definition.id}"`,
                    }),
                );
            }
            const observed = observedAnswer(answer);
            const answered =
                answer.kind === 'choice'
                    ? answer.label
                    : answer.kind === 'score'
                      ? answer.score
                      : answer.probability >= 0.5;
            if (observed.confidence < effectiveMinConfidence(definition, defaults)) {
                return outcome(
                    this.fallbackResult(
                        definition,
                        makerName,
                        'low-confidence',
                        observed.confidence,
                        start,
                        observed.probability,
                    ),
                    answered,
                );
            }
            const base = {
                id: definition.id,
                confidence: observed.confidence,
                source: 'model' as const,
                reason: 'accepted' as const,
                maker: makerName,
                durationMs: this.now() - start,
            };
            switch (answer.kind) {
                case 'choice':
                    return outcome({ ...base, type: 'choice', value: answer.label }, answered);
                case 'score':
                    return outcome({ ...base, type: 'score', value: answer.score }, answered);
                case 'noul':
                    return outcome(
                        {
                            ...base,
                            type: 'noul',
                            value: answer.probability >= 0.5,
                            probability: answer.probability,
                        },
                        answered,
                    );
            }
        } catch (error) {
            const reason =
                !inAsk || error instanceof DecisionConfigError
                    ? 'no-backend'
                    : error instanceof DecisionTimeoutError
                      ? 'timeout'
                      : 'error';
            return outcome(
                this.fallbackResult(definition, makerName, reason, null, start, undefined, toErrorInfo(error)),
            );
        }
    }

    /** Maker-chain precedence for discovery results: decision → catalog defaults → hub default. */
    private effectiveChain(definition: DecisionDefinition, defaults: CatalogDefaults): readonly string[] {
        const ref = definition.maker ?? defaults.maker;
        return ref === undefined ? [this.defaultMaker] : toChain(ref);
    }

    private mustGet(id: string): RegisteredDecision {
        const registered = this.decisions.get(id);
        if (registered === undefined) {
            const loaded = [...this.decisions.keys()];
            throw new UnknownDecisionError(
                `Unknown decision "${id}" — loaded decisions: ${loaded.length > 0 ? loaded.join(', ') : '(none)'}`,
                id,
            );
        }
        return registered;
    }

    /**
     * Build the declared-fallback envelope: `source: 'default'`, the observed
     * confidence (null when none), always the selected maker name. For noul,
     * `probability` stays null unless the answer itself supplied one.
     */
    private fallbackResult(
        definition: DecisionDefinition,
        makerName: string,
        reason: DecisionResultBase['reason'],
        confidence: number | null,
        start: number,
        probability?: number,
        error?: DecisionErrorInfo,
    ): DecisionResult {
        const base = {
            id: definition.id,
            confidence,
            source: 'default' as const,
            reason,
            maker: makerName,
            durationMs: this.now() - start,
            ...(error !== undefined ? { error } : {}),
        };
        switch (definition.type) {
            case 'choice':
                return { ...base, type: 'choice', value: definition.fallback as string };
            case 'score':
                return { ...base, type: 'score', value: definition.fallback as number };
            case 'noul':
                return {
                    ...base,
                    type: 'noul',
                    value: definition.fallback as boolean,
                    probability: probability ?? null,
                };
        }
    }
}

/** Options for {@link createDecisionHub}: one call from options to a ready hub. */
export interface CreateDecisionHubOptions extends DecisionHubOptions {
    /** Ignored when `registry` is supplied. Default: the three built-in makers. */
    readonly builtins?: BuiltinMakerOptions | false;
    /** Extra makers registered before any catalog loads (catalog checks run at load). */
    readonly makers?: Readonly<Record<string, MakerSource>>;
    /** Catalog files loaded in order with {@link CreateDecisionHubOptions.catalogOptions}. */
    readonly catalogs?: readonly string[];
    /** Forwarded to every `loadFile` call. */
    readonly catalogOptions?: CatalogLoadOptions;
}

/**
 * Build the registry, register `makers`, construct the hub and `loadFile` each
 * catalog in order. Any failure rejects; a partially built hub never escapes.
 */
export async function createDecisionHub(options: CreateDecisionHubOptions = {}): Promise<DecisionHub> {
    const registry = options.registry ?? new DecisionMakerRegistry({ builtins: options.builtins });
    for (const [name, source] of Object.entries(options.makers ?? {})) {
        registry.register(name, source);
    }
    const hub = new DecisionHub({ registry, defaultMaker: options.defaultMaker, now: options.now });
    for (const path of options.catalogs ?? []) {
        await hub.loadFile(path, options.catalogOptions);
    }
    return hub;
}
