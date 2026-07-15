/**
 * In-process registry of ProcessExecutor invocations (spur#0264 / M1).
 *
 * Tracks every `run` / `runStreaming` so board UIs (and other observers) can
 * list all harness-launched processes — not only supervisor-owned agent loops.
 * In-memory only; not durable across process restarts.
 */

/** Who initiated the spawn — used for filtering/grouping in consumers. */
export type ProcessExecutionSource = 'supervisor' | 'one-shot' | 'other';

/** Lifecycle status of a tracked execution. */
export type ProcessExecutionStatus = 'running' | 'exited';

/**
 * One ProcessExecutor invocation — the minimum metadata Spur's Processes tab
 * (and similar consumers) need for a full watch list.
 */
export interface ProcessExecution {
    /** Unique id for this execution (stable for the process lifetime). */
    readonly id: string;
    /** Optional human label (e.g. `agent:alpha-claude`). */
    readonly label?: string;
    readonly command: string;
    readonly args: readonly string[];
    /** OS pid when known (may arrive after spawn for buffered runs). */
    readonly pid?: number;
    /** ISO-8601 start time. */
    readonly startedAt: string;
    /** ISO-8601 end time when exited. */
    readonly exitedAt?: string;
    /** Exit code when exited (`null` for signal/timeout/error without code). */
    readonly exitCode?: number | null;
    readonly source: ProcessExecutionSource;
    /** Optional team association for board grouping. */
    readonly teamId?: string;
    /** Optional agent id when the spawn is agent-scoped. */
    readonly agentId?: string;
    readonly status: ProcessExecutionStatus;
}

/** Filter for {@link ProcessRegistry.listExecutions}. */
export interface ProcessExecutionFilter {
    readonly source?: ProcessExecutionSource;
    /** When true, only running; when false, only exited; omit for all. */
    readonly running?: boolean;
    readonly teamId?: string;
    readonly agentId?: string;
}

/** Events emitted by {@link ProcessRegistry.subscribe}. */
export type ProcessRegistryEvent =
    | { readonly type: 'started'; readonly execution: ProcessExecution }
    | { readonly type: 'exited'; readonly execution: ProcessExecution }
    | { readonly type: 'updated'; readonly execution: ProcessExecution };

/** Input for {@link ProcessRegistry.begin}. */
export interface ProcessExecutionBegin {
    readonly command: string;
    readonly args?: readonly string[];
    readonly label?: string;
    readonly source?: ProcessExecutionSource;
    readonly teamId?: string;
    readonly agentId?: string;
    readonly pid?: number;
    /** Override start timestamp (ISO-8601); defaults to now. */
    readonly startedAt?: string;
}

/** Completion patch for {@link ProcessRegistry.complete}. */
export interface ProcessExecutionComplete {
    readonly exitCode?: number | null;
    readonly pid?: number;
    /** Override end timestamp (ISO-8601); defaults to now. */
    readonly exitedAt?: string;
}

/**
 * Queryable registry of process executions.
 *
 * Implementations are process-local. Share one instance across every
 * {@link import('./process-executor').NodeProcessExecutor} that should appear
 * in the same watch list.
 */
export interface ProcessRegistry {
    /** Snapshot of tracked executions (newest-last), optionally filtered. */
    listExecutions(filter?: ProcessExecutionFilter): readonly ProcessExecution[];

    /** Lookup by id. */
    getExecution(id: string): ProcessExecution | undefined;

    /**
     * Subscribe to start / exit / field-update events.
     * @returns unsubscribe function
     */
    subscribe(listener: (event: ProcessRegistryEvent) => void): () => void;

    /** Record a new execution as running; returns its id. */
    begin(input: ProcessExecutionBegin): string;

    /** Patch mutable fields while running (e.g. pid once available). */
    update(id: string, patch: Pick<Partial<ProcessExecution>, 'pid' | 'label'>): void;

    /** Mark an execution exited (idempotent if already exited). */
    complete(id: string, update?: ProcessExecutionComplete): void;

    /** Drop all tracked executions (tests / shutdown). */
    clear(): void;
}

/**
 * Configuration for {@link createInMemoryProcessRegistry}.
 */
export interface InMemoryProcessRegistryOptions {
    /**
     * Maximum retained executions. When exceeded, oldest **exited** entries
     * are dropped first; if still over limit, oldest entries overall.
     * Default: 1000.
     */
    readonly maxEntries?: number;
}

let nextIdSeq = 0;

function allocateId(): string {
    nextIdSeq += 1;
    return `pe_${Date.now().toString(36)}_${nextIdSeq.toString(36)}`;
}

/**
 * Default in-memory {@link ProcessRegistry}.
 *
 * Create one per process (or per spur-serve) and inject it into every
 * `NodeProcessExecutor` that should contribute to the shared watch list:
 *
 * ```ts
 * const registry = createInMemoryProcessRegistry();
 * const exec = new NodeProcessExecutor({ registry });
 * ```
 */
export class InMemoryProcessRegistry implements ProcessRegistry {
    private readonly maxEntries: number;
    private readonly byId = new Map<string, ProcessExecution>();
    /** Insertion order for retention / list ordering. */
    private readonly order: string[] = [];
    private readonly listeners = new Set<(event: ProcessRegistryEvent) => void>();

    constructor(options: InMemoryProcessRegistryOptions = {}) {
        this.maxEntries = options.maxEntries ?? 1000;
    }

    listExecutions(filter?: ProcessExecutionFilter): readonly ProcessExecution[] {
        const out: ProcessExecution[] = [];
        for (const id of this.order) {
            const exec = this.byId.get(id);
            if (!exec) continue;
            if (filter?.source !== undefined && exec.source !== filter.source) continue;
            if (filter?.running === true && exec.status !== 'running') continue;
            if (filter?.running === false && exec.status !== 'exited') continue;
            if (filter?.teamId !== undefined && exec.teamId !== filter.teamId) continue;
            if (filter?.agentId !== undefined && exec.agentId !== filter.agentId) continue;
            out.push(exec);
        }
        return out;
    }

    getExecution(id: string): ProcessExecution | undefined {
        return this.byId.get(id);
    }

    subscribe(listener: (event: ProcessRegistryEvent) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    begin(input: ProcessExecutionBegin): string {
        const id = allocateId();
        const execution: ProcessExecution = {
            id,
            command: input.command,
            args: Object.freeze([...(input.args ?? [])]),
            source: input.source ?? 'other',
            startedAt: input.startedAt ?? new Date().toISOString(),
            status: 'running',
            ...(input.label !== undefined ? { label: input.label } : {}),
            ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
            ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
            ...(input.pid !== undefined ? { pid: input.pid } : {}),
        };
        this.byId.set(id, execution);
        this.order.push(id);
        this.enforceCap();
        this.emit({ type: 'started', execution });
        return id;
    }

    update(id: string, patch: Pick<Partial<ProcessExecution>, 'pid' | 'label'>): void {
        const current = this.byId.get(id);
        if (!current) return;
        const next: ProcessExecution = {
            ...current,
            ...(patch.pid !== undefined ? { pid: patch.pid } : {}),
            ...(patch.label !== undefined ? { label: patch.label } : {}),
        };
        this.byId.set(id, next);
        this.emit({ type: 'updated', execution: next });
    }

    complete(id: string, update: ProcessExecutionComplete = {}): void {
        const current = this.byId.get(id);
        if (!current) return;
        if (current.status === 'exited') {
            // Already completed — still allow pid fill-in if missing.
            if (update.pid !== undefined && current.pid === undefined) {
                const patched: ProcessExecution = { ...current, pid: update.pid };
                this.byId.set(id, patched);
                this.emit({ type: 'updated', execution: patched });
            }
            return;
        }
        const next: ProcessExecution = {
            ...current,
            status: 'exited',
            exitedAt: update.exitedAt ?? new Date().toISOString(),
            exitCode: update.exitCode !== undefined ? update.exitCode : null,
            ...(update.pid !== undefined ? { pid: update.pid } : {}),
        };
        this.byId.set(id, next);
        this.emit({ type: 'exited', execution: next });
    }

    clear(): void {
        this.byId.clear();
        this.order.length = 0;
    }

    private emit(event: ProcessRegistryEvent): void {
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch {
                // Listener errors must not break process tracking.
            }
        }
    }

    private enforceCap(): void {
        while (this.order.length > this.maxEntries) {
            // Prefer dropping oldest exited entries.
            let dropIdx = this.order.findIndex((id) => this.byId.get(id)?.status === 'exited');
            if (dropIdx < 0) dropIdx = 0;
            const [removed] = this.order.splice(dropIdx, 1);
            if (removed !== undefined) this.byId.delete(removed);
        }
    }
}

/** Factory for a default in-memory registry (preferred public constructor). */
export function createInMemoryProcessRegistry(options?: InMemoryProcessRegistryOptions): ProcessRegistry {
    return new InMemoryProcessRegistry(options);
}
