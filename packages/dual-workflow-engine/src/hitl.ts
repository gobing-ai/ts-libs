/** Categories of human-in-the-loop interaction. */
export type HitlRequestKind = 'confirm' | 'select' | 'input';

/** A request for human input during workflow execution. */
export interface HitlRequest {
    kind: HitlRequestKind;
    prompt: string;
    /** select: the choices; confirm: optional labels; input: ignored. */
    options?: string[];
    /** echoed back for correlation. */
    runId: string;
    node: string;
}

/** The user's response to a HITL request. */
export interface HitlAnswer {
    /** confirm -> 'yes'|'no'|'cancel'; select -> chosen option; input -> free text. */
    value: string;
    /** convenience: true when the user cancelled (confirm 'cancel'). */
    cancelled?: boolean;
}

/**
 * Contract for resolving HITL requests. Implementations are per-host
 * (spur provides CLI/headless responders in task 0035). This engine
 * package ships the interface only — no implementation.
 */
export interface HitlResponder {
    respond(request: HitlRequest): Promise<HitlAnswer>;
}
