import type { EventSeverity } from '@gobing-ai/ts-infra';
import type { ConstraintFinding } from './types';

/** Typed event map for rule-engine run observability. All events prefixed `rule.`. */
export type RuleEngineEvents = {
    /** Emitted before the first rule is evaluated. */
    'rule.run.start': (data: { rules: number; total: number; severity: EventSeverity }) => void;
    /** Emitted immediately before a single rule's evaluator is invoked. */
    'rule.eval.start': (data: { ruleId: string; index: number; total: number; severity: EventSeverity }) => void;
    /**
     * Emitted after a single rule evaluation finishes successfully.
     * `findings` is the count; `details` carries the actual finding objects so
     * progress subscribers can render per-rule detail inline without waiting
     * for the aggregate result.
     */
    'rule.eval.done': (data: {
        ruleId: string;
        findings: number;
        durationMs: number;
        details: ConstraintFinding[];
        severity: EventSeverity;
    }) => void;
    /** Emitted when a rule evaluator throws (in addition to the `kind:'error'` finding). */
    'rule.eval.error': (data: { ruleId: string; error: string; severity: EventSeverity }) => void;
    /** Emitted after the last rule finishes (or was short-circuited). */
    'rule.run.done': (data: {
        rules: number;
        findings: number;
        durationMs: number;
        stoppedEarly: boolean;
        severity: EventSeverity;
    }) => void;
};
