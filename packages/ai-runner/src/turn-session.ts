import { createHash, randomUUID } from 'node:crypto';
import type { PipeProcess, ProcessExecutor } from '@gobing-ai/ts-runtime';
import type { AgentName } from './agents/shims';

/**
 * Correlated warm-turn session facade (task 1284, design `fleet-task-turn-execution.md` §4–5,
 * ADR-145): ts-ai-runner owns the process/protocol mechanics of one long-lived agent session;
 * consumers (Spur) own policy, receipts and validation. 0.x ships the CONTRACT with no
 * real-agent driver registered — claude/pi/codex drivers land with their qualification
 * evidence in Spur tasks 1276–1278.
 */

/** Terminal classification of one turn. Exactly one outcome per turn, never upgraded after resolution. */
export type TurnOutcomeKind =
    | 'success'
    | 'failure'
    | 'interrupted'
    | 'not-started'
    | 'outcome-unknown'
    | 'contract-violation';

/** Correlation carried on every turn: the runner-level ids plus the caller's per-request identity. */
export interface TurnCorrelation {
    readonly runId: string;
    readonly executionId: string;
    readonly requestId: string;
    readonly attempt: number;
}

/** Durable session placement; digested into `policyDigest` for consumer-side reuse checks. */
export interface TurnSessionPolicy {
    workspace: string;
    role: string;
    model?: string;
    provider?: string;
    reasoning?: string;
    tools?: readonly string[];
    permissions?: string;
}

/** One resolved turn. `nativeSessionId`/`nativeTurnId` are present only when the driver observed them. */
export interface TurnOutcome {
    kind: TurnOutcomeKind;
    turnId: string;
    correlation: TurnCorrelation;
    nativeSessionId?: string;
    nativeTurnId?: string;
    reason?: string;
    finalText?: string;
    startedAt: string;
    acceptedAt?: string;
    firstOutputAt?: string;
    terminalAt: string;
}

/** Turn progress events surfaced live on a handle; `terminal` is the last event. */
export type TurnEvent =
    | { type: 'accepted'; turnId: string; at: string }
    | { type: 'output'; turnId: string; at: string; data?: unknown }
    | { type: 'diagnostic'; turnId: string; at: string; data?: unknown }
    | { type: 'terminal'; turnId: string; at: string; outcome: TurnOutcome };

/** One started turn: acceptance and outcome are SEPARATE promises (acceptance ≠ completion). */
export interface TurnHandle {
    readonly turnId: string;
    /** Resolves once the agent accepted the turn; `null` when the process died before acceptance. */
    readonly accepted: Promise<{ acceptedAt: string } | null>;
    /** Resolves exactly once to the terminal outcome. */
    readonly outcome: Promise<TurnOutcome>;
    /** Live event stream; completes when the outcome resolves. */
    readonly events: AsyncIterable<TurnEvent>;
    /** Request cancellation; resolves with the final outcome (deterministic, bounded by the grace). */
    cancel(reason: string, options?: { graceMs?: number }): Promise<TurnOutcome>;
}

/** An open session over one agent process. Admits ONE active turn; busy is an error, not a queue. */
export interface TurnSession {
    readonly agent: AgentName;
    /** sha256 of the canonical-JSON policy (stable key order) — consumers compare digests for reuse. */
    readonly policyDigest: string;
    readonly nativeSessionId?: string;
    readonly state: 'ready' | 'busy' | 'closed';
    startTurn(input: {
        prompt: string;
        correlation: TurnCorrelation;
        timeoutMs?: number;
        signal?: AbortSignal;
    }): TurnHandle;
    close(): Promise<void>;
}

/** Resolved agent binary identity a driver qualifies and spawns. */
export interface TurnBinary {
    path: string;
    /** `null` when the version could not be probed — drivers decide whether that qualifies. */
    version: string | null;
}

/** A wire-level terminal extracted from one decoded line. */
export interface TurnWireTerminal {
    kind: 'success' | 'failure';
    nativeTurnId?: string;
    nativeSessionId?: string;
    finalText?: string;
    reason?: string;
}

/** One decoded protocol frame routed by `turnId` (`null` = foreign/unattributable → diagnostic). */
export interface TurnWireEvent {
    turnId: string | null;
    type: 'accepted' | 'output' | 'diagnostic' | 'terminal';
    data?: unknown;
    terminal?: TurnWireTerminal;
}

/** Thrown by `TurnSessionDriver.decode` on a malformed frame — settles the turn `contract-violation`. */
export class TurnProtocolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TurnProtocolError';
    }
}

/** Handshake result: the native session id when the agent reported one during startup. */
export type TurnHandshake = { nativeSessionId?: string } | null;

/**
 * Per-agent driver behind the session facade. Real drivers are registered only with recorded
 * `verifiedAgainst` qualification evidence (anti-pattern: registration without evidence).
 */
export interface TurnSessionDriver {
    readonly agent: AgentName;
    qualify(binary: TurnBinary): { qualified: true } | { qualified: false; reason: string };
    spawnArgv(binary: TurnBinary, policy: TurnSessionPolicy): { command: string; args: string[] };
    /**
     * Consume startup lines until the agent is ready; reject/throw on a bad handshake. Absent =
     * no handshake. Pull via `pull(timeoutMs)` — NOT `for await` over a stream — because an
     * early `return`/`break` in a for-await CLOSES the shared iterator the session pump needs.
     */
    handshake?(pull: (timeoutMs: number) => Promise<string | null>): Promise<TurnHandshake>;
    encodeTurn(input: { turnId: string; prompt: string; correlation: TurnCorrelation }): string;
    /** Decode one stdout line into zero or more frames; throws {@link TurnProtocolError} on malformed input. */
    decode(line: string): TurnWireEvent[];
    encodeCancel(reason: string): string;
}

/** Outcome of {@link AiRunner.openTurnSession}: an open session or a typed failure reason. */
export type OpenTurnSessionResult =
    | { ok: true; session: TurnSession }
    | {
          ok: false;
          reason: 'unsupported-agent' | 'unqualified-version' | 'spawn-failed' | 'handshake-failed';
          detail: string;
      };

/** Built-in driver registry. Empty in 0.x by design — real drivers land with qualification evidence. */
export const TURN_SESSION_DRIVERS: ReadonlyMap<AgentName, TurnSessionDriver> = new Map();

/** How long `cancel()` waits for native terminal evidence before resolving `outcome-unknown`. */
export const TURN_CANCEL_GRACE_MS = 5_000;
/** Handshake bound for `openTurnSession`. */
export const TURN_HANDSHAKE_TIMEOUT_MS = 10_000;
/** Max buffered stdout line; overflow is a protocol contract violation. */
export const TURN_MAX_LINE_BYTES = 1024 * 1024;

/** `startTurn` while another turn is active — no hidden queue, by design. */
export class TurnSessionBusyError extends Error {
    constructor(turnId: string) {
        super(`turn session busy: turn ${turnId} is still active`);
        this.name = 'TurnSessionBusyError';
    }
}

/** `startTurn` on a closed session. */
export class TurnSessionClosedError extends Error {
    constructor() {
        super('turn session is closed');
        this.name = 'TurnSessionClosedError';
    }
}

/** sha256 over the canonical JSON (recursively sorted keys) of the policy — stable digest contract. */
export function turnSessionPolicyDigest(policy: TurnSessionPolicy): string {
    const canonical = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(canonical);
        if (value !== null && typeof value === 'object') {
            return Object.fromEntries(
                Object.entries(value as Record<string, unknown>)
                    .sort(([a], [b]) => (a < b ? -1 : 1))
                    .map(([key, item]) => [key, canonical(item)]),
            );
        }
        return value;
    };
    return createHash('sha256')
        .update(JSON.stringify(canonical(policy)))
        .digest('hex');
}

/**
 * Line-buffered stdout reader with the bounded-buffer invariant (overflow invokes `onOverflow`
 * and ends the iteration). The single reader of the process stdout stream — both the handshake
 * and the session pump pull from the SAME generator.
 */
export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let buffer = '';
    const reader = stream.getReader();
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            for (;;) {
                const newline = buffer.indexOf('\n');
                if (newline === -1) break;
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                if (Buffer.byteLength(line, 'utf8') > TURN_MAX_LINE_BYTES) {
                    throw new TurnProtocolError(`stdout line exceeded ${TURN_MAX_LINE_BYTES} bytes`);
                }
                yield line;
            }
        }
        const tail = buffer + decoder.decode();
        if (tail.length > 0) yield tail;
    } finally {
        reader.releaseLock();
    }
}

function delay(ms: number): Promise<null> {
    return new Promise((resolve) => {
        setTimeout(() => resolve(null), ms);
    });
}

/** Per-turn state: deferred accepted/outcome promises, event queue, exactly-once settlement. */
class ActiveTurn implements TurnHandle {
    readonly turnId: string;
    readonly correlation: TurnCorrelation;
    readonly startedAt = new Date().toISOString();
    acceptedAt: string | undefined;
    firstOutputAt: string | undefined;
    outcomeResolved = false;
    cancelRequested = false;
    readonly accepted: Promise<{ acceptedAt: string } | null>;
    readonly outcome: Promise<TurnOutcome>;
    readonly events: AsyncIterable<TurnEvent>;
    cancelHook: ((reason: string, graceMs: number) => Promise<TurnOutcome>) | undefined;

    private acceptResolve: ((value: { acceptedAt: string } | null) => void) | undefined;
    private outcomeResolve: ((outcome: TurnOutcome) => void) | undefined;
    private settledResolve: ((settled: boolean) => void) | undefined;
    private readonly queue: TurnEvent[] = [];
    private eventWake: (() => void) | undefined;
    private eventsClosed = false;
    private sessionNativeSessionId: string | undefined;
    private readonly settledPromiseField: Promise<boolean>;

    constructor(init: ActiveTurnInit) {
        this.turnId = init.turnId;
        this.correlation = init.correlation;
        this.sessionNativeSessionId = init.nativeSessionId;
        this.accepted = new Promise((resolve) => {
            this.acceptResolve = resolve;
        });
        this.outcome = new Promise((resolve) => {
            this.outcomeResolve = resolve;
        });
        const settledPromise = new Promise<boolean>((resolve) => {
            this.settledResolve = resolve;
        });
        const self = this;
        this.events = {
            async *[Symbol.asyncIterator]() {
                while (true) {
                    while (self.queue.length > 0) {
                        const event = self.queue.shift();
                        if (event !== undefined) yield event;
                    }
                    if (self.eventsClosed) return;
                    await new Promise<void>((resolve) => {
                        self.eventWake = resolve;
                    });
                    self.eventWake = undefined;
                }
            },
        };
        this.settledPromiseField = settledPromise;
    }

    get settled(): Promise<boolean> {
        return this.settledPromiseField;
    }

    emit(event: DistributiveOmit<TurnEvent, 'turnId' | 'at'>): void {
        this.queue.push({ ...event, turnId: this.turnId, at: new Date().toISOString() } as TurnEvent);
        this.eventWake?.();
    }

    private resolveAccepted(value: { acceptedAt: string } | null): void {
        this.acceptResolve?.(value);
        this.acceptResolve = undefined;
    }

    /** The agent accepted the turn — resolves the `accepted` promise (idempotent). */
    markAccepted(): void {
        if (this.acceptedAt !== undefined) return;
        this.acceptedAt = new Date().toISOString();
        this.resolveAccepted({ acceptedAt: this.acceptedAt });
    }

    /** Exactly-once settlement: the first call wins; the outcome never upgrades afterwards. */
    settle(
        partial: Omit<TurnOutcome, 'turnId' | 'correlation' | 'startedAt' | 'terminalAt'> & { kind: TurnOutcomeKind },
    ): void {
        if (this.outcomeResolved) return;
        this.outcomeResolved = true;
        this.eventsClosed = true;
        this.eventWake?.();
        this.resolveAccepted(this.acceptedAt === undefined ? null : { acceptedAt: this.acceptedAt });
        const outcome: TurnOutcome = {
            kind: partial.kind,
            turnId: this.turnId,
            correlation: this.correlation,
            startedAt: this.startedAt,
            terminalAt: new Date().toISOString(),
            ...(this.acceptedAt !== undefined ? { acceptedAt: this.acceptedAt } : {}),
            ...(this.firstOutputAt !== undefined ? { firstOutputAt: this.firstOutputAt } : {}),
            ...(partial.nativeSessionId !== undefined
                ? { nativeSessionId: partial.nativeSessionId }
                : this.sessionNativeSessionId !== undefined
                  ? { nativeSessionId: this.sessionNativeSessionId }
                  : {}),
            ...(partial.nativeTurnId !== undefined ? { nativeTurnId: partial.nativeTurnId } : {}),
            ...(partial.reason !== undefined ? { reason: partial.reason } : {}),
            ...(partial.finalText !== undefined ? { finalText: partial.finalText } : {}),
        };
        this.emit({ type: 'terminal', outcome });
        this.outcomeResolve?.(outcome);
        this.settledResolve?.(true);
    }

    async cancel(reason: string, options?: { graceMs?: number }): Promise<TurnOutcome> {
        return await (this.cancelHook?.(reason, options?.graceMs ?? TURN_CANCEL_GRACE_MS) ?? this.outcome);
    }
}

interface ActiveTurnInit {
    turnId: string;
    correlation: TurnCorrelation;
    nativeSessionId: string | undefined;
}

/** Omit distributes over unions — `Omit<TurnEvent, …>` alone collapses the union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The one session implementation: one active turn, deterministic settlement, diagnostics for stray frames. */
class TurnSessionImpl implements TurnSession {
    readonly agent: AgentName;
    readonly policyDigest: string;
    nativeSessionId: string | undefined;
    state: 'ready' | 'busy' | 'closed' = 'ready';
    private readonly process: PipeProcess;
    private readonly driver: TurnSessionDriver;
    private readonly lines: AsyncIterable<string>;
    private active: ActiveTurn | undefined;
    /** Most recent turn — kept so frames arriving after settlement surface as diagnostics. */
    private lastTurn: ActiveTurn | undefined;

    constructor(options: {
        agent: AgentName;
        process: PipeProcess;
        driver: TurnSessionDriver;
        policy: TurnSessionPolicy;
        nativeSessionId: string | undefined;
        lines: AsyncIterable<string>;
    }) {
        this.agent = options.agent;
        this.process = options.process;
        this.driver = options.driver;
        this.policyDigest = turnSessionPolicyDigest(options.policy);
        this.nativeSessionId = options.nativeSessionId;
        this.lines = options.lines;
        void this.pump();
        void this.process.exited.then(() => {
            this.onExit();
        });
    }

    startTurn(input: { prompt: string; correlation: TurnCorrelation }): TurnHandle {
        if (this.state === 'closed') throw new TurnSessionClosedError();
        if (this.active !== undefined) throw new TurnSessionBusyError(this.active.turnId);
        const turnId = randomUUID();
        const turn = new ActiveTurn({
            turnId,
            correlation: input.correlation,
            nativeSessionId: this.nativeSessionId,
        });
        turn.cancelHook = (reason, graceMs) => this.cancelTurn(turn, reason, graceMs);
        this.active = turn;
        this.state = 'busy';
        try {
            this.process.writeStdin(
                this.driver.encodeTurn({ turnId, prompt: input.prompt, correlation: input.correlation }),
            );
        } catch (error) {
            // A dead stdin means the process is gone: the turn never started.
            turn.settle({ kind: 'not-started', reason: error instanceof Error ? error.message : String(error) });
        }
        return turn;
    }

    /** Send the cancel frame; wait at most `graceMs` for native terminal evidence, else leave it to the exit path. */
    private async cancelTurn(turn: ActiveTurn, reason: string, graceMs: number): Promise<TurnOutcome> {
        if (!turn.outcomeResolved) {
            turn.cancelRequested = true;
            try {
                this.process.writeStdin(this.driver.encodeCancel(reason));
            } catch {
                // stdin gone — the exit handler settles deterministically.
            }
            await Promise.race([turn.settled, delay(graceMs)]);
            if (!turn.outcomeResolved)
                turn.settle({
                    kind: 'outcome-unknown',
                    reason: `cancel grace (${graceMs}ms) expired without native terminal evidence`,
                });
        }
        return await turn.outcome;
    }

    async close(): Promise<void> {
        if (this.state === 'closed') return;
        const turn = this.active;
        if (turn !== undefined && !turn.outcomeResolved) {
            turn.cancelRequested = true;
            try {
                this.process.writeStdin(this.driver.encodeCancel('session closing'));
            } catch {
                // stdin gone
            }
            await Promise.race([turn.settled, delay(TURN_CANCEL_GRACE_MS)]);
            turn.settle({
                kind: turn.acceptedAt === undefined ? 'not-started' : 'outcome-unknown',
                reason: 'session closed',
            });
        }
        this.state = 'closed';
        this.active = undefined;
        try {
            this.process.endStdin();
        } catch {
            // already dead
        }
        this.process.kill('SIGTERM');
        const gone = await Promise.race([this.process.exited, delay(5_000)]);
        if (gone === null) this.process.kill('SIGKILL');
    }

    /** Route decoded frames; foreign or late frames become diagnostics on the recent turn. */
    private route(wire: TurnWireEvent): void {
        const turn = this.active ?? this.lastTurn;
        if (turn === undefined) return; // nowhere to surface a frame without a turn
        if (wire.turnId !== turn.turnId || turn.outcomeResolved) {
            turn.emit({ type: 'diagnostic', data: wire });
            return;
        }
        const at = new Date().toISOString();
        if (wire.type === 'output') {
            turn.firstOutputAt ??= at;
            turn.emit({ type: 'output', data: wire.data });
            return;
        }
        if (wire.type === 'terminal' && wire.terminal !== undefined) {
            const kind: TurnOutcomeKind = turn.cancelRequested
                ? 'interrupted'
                : wire.terminal.kind === 'success'
                  ? 'success'
                  : 'failure';
            turn.settle({
                kind,
                ...(wire.terminal.nativeTurnId !== undefined ? { nativeTurnId: wire.terminal.nativeTurnId } : {}),
                ...(wire.terminal.nativeSessionId !== undefined
                    ? { nativeSessionId: wire.terminal.nativeSessionId }
                    : {}),
                ...(wire.terminal.finalText !== undefined ? { finalText: wire.terminal.finalText } : {}),
                ...(wire.terminal.reason !== undefined ? { reason: wire.terminal.reason } : {}),
            });
            // Turn complete: keep the reference for late-frame diagnostics, admit the next turn.
            this.lastTurn = turn;
            if (this.active === turn) {
                this.active = undefined;
                if (this.state === 'busy') this.state = 'ready';
            }
            return;
        }
        if (wire.type === 'accepted') {
            if (turn.acceptedAt === undefined) {
                turn.acceptedAt = at;
                turn.markAccepted();
                turn.emit({ type: 'accepted' });
            } else {
                turn.emit({ type: 'diagnostic', data: wire });
            }
            return;
        }
        turn.emit({ type: 'diagnostic', data: wire });
    }

    private async pump(): Promise<void> {
        // The reader itself can throw (line overflow → TurnProtocolError) — either way the turn
        // settles contract-violation.
        try {
            for await (const line of this.lines) {
                const wires = this.driver.decode(line);
                for (const wire of wires) this.route(wire);
            }
        } catch (error) {
            this.active?.settle({
                kind: 'contract-violation',
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /** Deterministic settlement when the process dies: before acceptance → not-started, after → unknown. */
    private onExit(): void {
        const turn = this.active;
        this.state = 'closed';
        if (turn === undefined) return;
        if (!turn.outcomeResolved) {
            if (turn.acceptedAt === undefined)
                turn.settle({ kind: 'not-started', reason: 'process exited before acceptance' });
            else turn.settle({ kind: 'outcome-unknown', reason: 'process exited without a native terminal' });
        }
    }
}

/**
 * Open a turn session: driver lookup → qualification → spawn → handshake → session. Expected
 * refusals are typed values, never throws (R1). `resolveBinary`/`resolveDriver` are seams:
 * `AiRunner.openTurnSession` binds them to its agent resolution; tests bind the fake driver.
 */
export async function openTurnSessionWithDriver(options: {
    agent: AgentName;
    driver: TurnSessionDriver | undefined;
    policy: TurnSessionPolicy;
    binary: TurnBinary;
    processExecutor: ProcessExecutor;
    handshakeTimeoutMs?: number;
}): Promise<OpenTurnSessionResult> {
    const { agent, driver, policy, binary, processExecutor } = options;
    if (driver === undefined) {
        return {
            ok: false,
            reason: 'unsupported-agent',
            detail: `no turn-session driver registered for agent '${agent}' (registry: ${[...TURN_SESSION_DRIVERS.keys()].join(', ') || 'empty'})`,
        };
    }
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? TURN_HANDSHAKE_TIMEOUT_MS;
    const qualification = driver.qualify(binary);
    if (!qualification.qualified) {
        return {
            ok: false,
            reason: 'unqualified-version',
            detail: `${agent} ${binary.version ?? '<no version>'}: ${qualification.reason}`,
        };
    }
    const argv = driver.spawnArgv(binary, policy);
    let process: PipeProcess;
    try {
        process = processExecutor.runStreaming({
            command: argv.command,
            args: argv.args,
            label: `turn-session.${agent}`,
            cwd: policy.workspace,
        });
    } catch (error) {
        return { ok: false, reason: 'spawn-failed', detail: error instanceof Error ? error.message : String(error) };
    }
    if (process.stdout === null) {
        void process.kill('SIGTERM');
        return {
            ok: false,
            reason: 'handshake-failed',
            detail: `${agent} process has no stdout to speak the turn protocol`,
        };
    }
    const lines = readLines(process.stdout);
    const iterator = lines[Symbol.asyncIterator]();
    // Handshake pulls lines one at a time with its own timeout; a timeout or EOF yields null.
    // The line lost to a timeout is irrelevant: a timeout fails the handshake and kills the process.
    const pull = (timeoutMs: number): Promise<string | null> =>
        Promise.race([iterator.next().then((step) => (step.done ? null : step.value)), delay(timeoutMs)]);
    let handshakeResult: TurnHandshake = null;
    if (driver.handshake !== undefined) {
        // A handshake that loses the race (or throws) must not surface as an unhandled rejection.
        const handshake = driver.handshake(pull).catch(() => null);
        try {
            handshakeResult = await Promise.race([handshake, delay(handshakeTimeoutMs)]);
        } catch {
            void process.kill('SIGTERM');
            return { ok: false, reason: 'handshake-failed', detail: `${agent} handshake failed` };
        }
        if (handshakeResult === null) {
            void process.kill('SIGTERM');
            return {
                ok: false,
                reason: 'handshake-failed',
                detail: `${agent} did not become ready within ${handshakeTimeoutMs}ms`,
            };
        }
    }
    return {
        ok: true,
        session: new TurnSessionImpl({
            agent,
            process,
            driver,
            policy,
            nativeSessionId: handshakeResult?.nativeSessionId,
            lines,
        }),
    };
}
