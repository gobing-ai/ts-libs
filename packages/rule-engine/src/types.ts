import { z } from 'zod';

/** Finding severity emitted by the rule engine. */
export type RuleSeverity = 'error' | 'warning' | 'info';

/** Fix authority level for candidate fixes. */
export type FixMode = 'none' | 'suggest' | 'auto';

/** Structured configuration for a rule evaluator. */
export interface RuleEvaluatorConfig {
    /** Evaluator type key registered in the host. */
    type: string;
    /** Evaluator-specific options. */
    config?: Record<string, unknown>;
}

/** Constraint rule definition loaded from YAML or JSON. */
export interface ConstraintRule {
    /** Stable rule identifier. */
    id: string;
    /** Human-readable description. */
    description: string;
    /** Whether this rule is active. */
    enabled: boolean;
    /** Finding severity emitted by this rule. */
    severity: RuleSeverity;
    /** Evaluator configuration. */
    evaluator: RuleEvaluatorConfig;
    /** Optional include globs or paths. */
    include?: string[];
    /** Optional exclude globs or paths. */
    exclude?: string[];
    /** Optional fix metadata. */
    fix?: RuleFixConfig;
}

/** Fix configuration authored on a rule. */
export interface RuleFixConfig {
    /** Maximum fix mode allowed by the rule. */
    mode: FixMode;
    /** Optional replacement text used by simple fixers. */
    replacement?: string;
    /** Optional fixer-specific parameters. */
    params?: Record<string, unknown>;
}

/** Rule file shape before normalization. */
export interface ConstraintRuleFile {
    /** File-level default include patterns. */
    include?: string[];
    /** File-level default exclude patterns. */
    exclude?: string[];
    /** File-level default severity. */
    severity?: RuleSeverity;
    /** Rule definitions. */
    rules: ConstraintRule[];
}

/** Relative module paths a preset contributes per capability kind. */
export interface PresetExtensions {
    /** Test-path resolver module paths. */
    resolvers?: string[];
    /** Evaluator module paths. */
    evaluators?: string[];
    /** Fixer module paths. */
    fixers?: string[];
    /** Formatter module paths. */
    formatters?: string[];
}

/** Preset definition that composes category folders or other presets. */
export interface PresetDefinition {
    /** Preset name. */
    name: string;
    /** Category folders or preset names to compose. */
    extends: string[];
    /** Rule IDs to disable. */
    disable?: string[];
    /** Per-rule overrides. */
    overrides?: Record<string, { fix?: { mode: FixMode } }>;
    /** Custom capability modules contributed by this preset (opt-in to load). */
    extensions?: PresetExtensions;
}

/** Candidate fix emitted by an evaluator or fixer. */
export interface Fix {
    /** Rule that produced this fix. */
    ruleId: string;
    /** Relative or absolute target file path. */
    filePath: string;
    /** Byte start offset. */
    start: number;
    /** Byte end offset. */
    end: number;
    /** Replacement content. */
    replacement: string;
    /** Whether this fix may be applied automatically. */
    mode: Exclude<FixMode, 'none'>;
}

/**
 * What a finding represents.
 *
 * - `violation`: the rule ran and the project breached its policy (the default).
 * - `error`: the rule could not run — a misconfiguration or runtime fault in the
 *   evaluator itself. These are not policy breaches and callers may surface them
 *   separately (e.g. "rule misconfigured") rather than as project violations.
 */
export type FindingKind = 'violation' | 'error';

/** Finding emitted by a constraint rule. */
export interface ConstraintFinding {
    /** Rule identifier. */
    ruleId: string;
    /** Finding severity. */
    severity: RuleSeverity;
    /** Finding message. */
    message: string;
    /** Relative or absolute path involved in the finding. */
    filePath: string | null;
    /** Optional one-based line number. */
    line?: number;
    /** Optional column number. */
    column?: number;
    /** Machine-readable evaluator/source code. */
    code?: string;
    /** Whether this is a policy violation or an evaluator error. Absent means `violation`. */
    kind?: FindingKind;
}

/** Aggregate result returned by a rule evaluator. */
export interface RuleEvaluationResult {
    /** Findings emitted by the evaluator. */
    findings: ConstraintFinding[];
    /** Candidate fixes emitted by the evaluator. */
    fixes: Fix[];
}

/** Context passed to evaluator implementations. */
export interface RuleContext {
    /** Working directory being evaluated. */
    workdir: string;
    /** Rule being evaluated. */
    rule: ConstraintRule;
}

/** Evaluator implementation contract. */
export interface RuleEvaluator {
    /** Evaluate a rule against the supplied context. */
    evaluate(rule: ConstraintRule, context: RuleContext): Promise<RuleEvaluationResult>;
}

/** Formatter implementation contract. */
export interface ResultFormatter {
    /** Format an engine result for CLI or machine output. */
    format(result: RuleEngineResult): string;
}

/** Engine-level evaluation result. */
export interface RuleEngineResult {
    /** Findings emitted by enabled rules. */
    findings: ConstraintFinding[];
    /** Candidate fixes emitted by enabled rules. */
    fixes: Fix[];
}

/** Create a finding with inherited rule severity. */
export function createFinding(
    rule: ConstraintRule,
    message: string,
    filePath: string | null,
    extras: Omit<Partial<ConstraintFinding>, 'ruleId' | 'severity' | 'message' | 'filePath'> = {},
): ConstraintFinding {
    return {
        ruleId: rule.id,
        severity: rule.severity,
        message,
        filePath,
        ...extras,
    };
}

/** Zod schema for rule fix configuration. */
export const RuleFixConfigSchema = z
    .object({
        mode: z.enum(['none', 'suggest', 'auto']).default('none'),
        replacement: z.string().optional(),
        params: z.record(z.string(), z.unknown()).optional(),
    })
    .default({ mode: 'none' });

/** Zod schema for a single constraint rule. */
export const ConstraintRuleSchema = z.object({
    id: z.string().min(1),
    description: z.string().default(''),
    enabled: z.boolean().default(true),
    severity: z.enum(['error', 'warning', 'info']).default('error'),
    evaluator: z.object({
        type: z.string().min(1),
        config: z.record(z.string(), z.unknown()).optional(),
    }),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    fix: RuleFixConfigSchema.optional(),
});

/** Zod schema for a constraint rule file. */
export const ConstraintRuleFileSchema = z.object({
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    severity: z.enum(['error', 'warning', 'info']).optional(),
    rules: z.array(ConstraintRuleSchema),
});

/** Zod schema for a preset definition. */
export const PresetDefinitionSchema = z.object({
    name: z.string().min(1),
    extends: z.array(z.string()).default([]),
    disable: z.array(z.string()).optional(),
    overrides: z
        .record(z.string(), z.object({ fix: z.object({ mode: z.enum(['none', 'suggest', 'auto']) }).optional() }))
        .optional(),
    extensions: z
        .object({
            resolvers: z.array(z.string()).optional(),
            evaluators: z.array(z.string()).optional(),
            fixers: z.array(z.string()).optional(),
            formatters: z.array(z.string()).optional(),
        })
        .optional(),
});
