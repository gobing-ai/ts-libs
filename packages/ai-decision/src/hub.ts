import {
    type Answer,
    DecisionConfigError,
    type DecisionState,
    DecisionTimeoutError,
    type Json,
    type Question,
    q,
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
    /** decision → catalog defaults → hub defaultMaker. */
    readonly maker: string;
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
    /** Per-call maker name; wins over the decision's, the catalog's and the hub default. */
    readonly maker?: string;
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
     * duplicate decision id or an unregistered maker name (decision or
     * `defaults.maker`) throws {@link DecisionCatalogError} and registers
     * nothing from the offending catalog.
     */
    load(catalog: DecisionCatalog): void {
        const defaultsMaker = catalog.defaults.maker;
        if (defaultsMaker !== undefined && !this.registry.has(defaultsMaker)) {
            throw new DecisionCatalogError(
                `Catalog "${catalog.source}" defaults.maker '${defaultsMaker}' is not registered in the hub registry ` +
                    `(registered: ${this.registry.names().join(', ') || 'none'})`,
                catalog.source,
                undefined,
                'maker',
            );
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
            if (definition.maker !== undefined && !this.registry.has(definition.maker)) {
                throw new DecisionCatalogError(
                    `Decision "${id}" in catalog "${catalog.source}" names maker '${definition.maker}' that is not ` +
                        `registered in the hub registry (registered: ${this.registry.names().join(', ') || 'none'})`,
                    catalog.source,
                    id,
                    'maker',
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
            maker: this.effectiveMakerName(definition, defaults),
            ...(model !== undefined ? { model } : {}),
        };
    }

    /**
     * Serve one decision with a fallback-guaranteed answer. Resolves the input,
     * renders exactly one Jev question keyed by the decision id, selects the
     * maker by name (per call → decision → catalog defaults → hub default) and
     * issues a single `maker.ask`. Backend construction, transport, timeout,
     * invalid answers and low confidence all resolve to the declared fallback;
     * only caller mistakes throw, before any backend call.
     */
    async decide(id: string, input: Record<string, Json> = {}, options: DecideOptions = {}): Promise<DecisionResult> {
        const start = this.now();
        const { definition, defaults } = this.mustGet(id); // UnknownDecisionError — caller error
        const params = resolveDecisionInput(definition, input); // DecisionInputError — caller error

        const makerName = options.maker ?? definition.maker ?? defaults.maker ?? this.defaultMaker;
        if (!this.registry.has(makerName)) {
            // Reachable only for a per-call name: catalog and hub default names are checked at
            // load/construct. It is a caller error, thrown before any backend interaction.
            throw new UnknownDecisionMakerError(
                `Decision "${id}" was asked on maker '${makerName}' that is not registered in the hub registry ` +
                    `(registered: ${this.registry.names().join(', ') || 'none'})`,
                makerName,
            );
        }

        const state: DecisionState = buildState(definition, params);
        const model = definition.model ?? defaults.model;
        const request = {
            state,
            questions: { [definition.id]: buildJevQuestion(renderQuestion(definition, params)) },
            ...(model !== undefined ? { model } : {}),
        };

        // The one auditable try/catch for steps 4–5: a resolve failure is a construction
        // failure (no-backend); ask failures map per the error taxonomy. Neither rejects.
        let inAsk = false;
        try {
            const maker = await this.registry.resolve(makerName);
            inAsk = true;
            const answers = await maker.ask(request);
            const answer: Answer | undefined = answers[definition.id];
            if (answer === undefined || answer.kind !== definition.type) {
                return this.fallbackResult(definition, makerName, 'error', null, start);
            }
            const observed = observedAnswer(answer);
            if (observed.confidence < effectiveMinConfidence(definition, defaults)) {
                return this.fallbackResult(
                    definition,
                    makerName,
                    'low-confidence',
                    observed.confidence,
                    start,
                    observed.probability,
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
                    return { ...base, type: 'choice', value: answer.label };
                case 'score':
                    return { ...base, type: 'score', value: answer.score };
                case 'noul':
                    return {
                        ...base,
                        type: 'noul',
                        value: answer.probability >= 0.5,
                        probability: answer.probability,
                    };
            }
        } catch (error) {
            const reason =
                !inAsk || error instanceof DecisionConfigError
                    ? 'no-backend'
                    : error instanceof DecisionTimeoutError
                      ? 'timeout'
                      : 'error';
            return this.fallbackResult(definition, makerName, reason, null, start);
        }
    }

    /** Maker-name precedence for discovery results: decision → catalog defaults → hub default. */
    private effectiveMakerName(definition: DecisionDefinition, defaults: CatalogDefaults): string {
        return definition.maker ?? defaults.maker ?? this.defaultMaker;
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
    ): DecisionResult {
        const base = {
            id: definition.id,
            confidence,
            source: 'default' as const,
            reason,
            maker: makerName,
            durationMs: this.now() - start,
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
