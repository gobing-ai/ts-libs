import { createDecisionMaker, type DecisionMaker, type DecisionMakerOptions } from '@gobing-ai/ts-ai-runner';
import { createFmDriver, type FmDriverOptions } from '@gobing-ai/ts-decision-fm';
import { createLayaDriver, type LayaDriverOptions } from '@gobing-ai/ts-laya-mlx';
import { DecisionRegistryError, UnknownDecisionMakerError } from './errors';

/** A maker, or a lazy factory for one (sync or async). Factories run on first `resolve` and are memoised on success. */
export type MakerSource = DecisionMaker | (() => DecisionMaker | Promise<DecisionMaker>);

/** Options for the three built-in makers pre-registered by {@link DecisionMakerRegistry} (task 0091 R2). */
export interface BuiltinMakerOptions {
    /** Forwarded to `createDecisionMaker` for every built-in (env, apiKey, baseURL, timeoutMs, ...). */
    readonly makerOptions?: Omit<DecisionMakerOptions, 'driver' | 'backend' | 'model'>;
    /** Driver options for the bundled local drivers; the fm platform check runs at first resolve, not registration. */
    readonly driverOptions?: { readonly 'fm-local'?: FmDriverOptions; readonly 'laya-local'?: LayaDriverOptions };
}

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Registry mapping plain names to {@link DecisionMaker}s (task 0091, ADR-033
 * § Maker registry). Built-ins are registered as lazy factories, so
 * `register`, `has` and `names` never construct a maker or driver; the first
 * `resolve` runs the factory and memoises the maker, while a failed factory
 * stays un-memoised so a later resolve retries (e.g. a model not yet
 * downloaded). No catalog dependency — catalog code depends on this, never
 * the reverse.
 */
export class DecisionMakerRegistry {
    private readonly entries = new Map<
        string,
        { source: MakerSource; maker?: DecisionMaker; pending?: Promise<DecisionMaker> }
    >();

    /** Pre-registers `typesafe`, `fm-local` and `laya-local` unless `builtins: false`. */
    constructor(options?: { builtins?: BuiltinMakerOptions | false }) {
        if (options?.builtins === false) return;
        const { makerOptions = {}, driverOptions = {} } = options?.builtins ?? {};
        this.register('typesafe', () => createDecisionMaker({ backend: 'typesafe', ...makerOptions }));
        this.register('fm-local', () =>
            createDecisionMaker({ driver: createFmDriver(driverOptions['fm-local'] ?? {}), ...makerOptions }),
        );
        this.register('laya-local', () =>
            createDecisionMaker({ driver: createLayaDriver(driverOptions['laya-local'] ?? {}), ...makerOptions }),
        );
    }

    /** Register a maker or factory under `name`; chains. Throws on a bad or already-registered name. */
    register(name: string, source: MakerSource): this {
        if (!NAME_PATTERN.test(name)) {
            throw new DecisionRegistryError(`Invalid decision maker name '${name}' — must match ${NAME_PATTERN}.`);
        }
        if (this.entries.has(name)) {
            throw new DecisionRegistryError(`Decision maker '${name}' is already registered.`);
        }
        this.entries.set(name, { source });
        return this;
    }

    has(name: string): boolean {
        return this.entries.has(name);
    }

    names(): string[] {
        return [...this.entries.keys()];
    }

    /**
     * Resolve `name` to a maker, running and memoising a factory on first use. Factory errors
     * propagate unchanged. Concurrent resolves of one name share a single in-flight factory run
     * so every caller gets the same instance; a rejected run is cleared so a later resolve retries.
     */
    async resolve(name: string): Promise<DecisionMaker> {
        const entry = this.entries.get(name);
        if (entry === undefined) {
            throw new UnknownDecisionMakerError(
                `Unknown decision maker '${name}' — register it or use a built-in.`,
                name,
            );
        }
        if (entry.maker) return entry.maker;
        // A check-then-set across `await` would let two concurrent callers run the factory and
        // receive different instances, so the run itself is memoised while in flight. The
        // rejection teardown attaches via .catch instead of a try/finally inside the run: with a
        // finally-based clear, Bun's test runner reports the settled rejection as an unhandled
        // error when a later resolve retries (false positive).
        if (!entry.pending) {
            const run = (async () => {
                const maker = typeof entry.source === 'function' ? await entry.source() : entry.source;
                entry.maker = maker;
                return maker;
            })();
            run.catch(() => {
                if (entry.pending === run) entry.pending = undefined; // allow a later resolve to retry
            });
            entry.pending = run;
        }
        return await entry.pending;
    }
}
