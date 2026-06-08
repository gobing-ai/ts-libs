import { assertRelativeExtensionPath } from '@gobing-ai/ts-runtime/extension';
import { z } from 'zod';

/** Finding severity emitted by the rule engine. */
export type RuleSeverity = 'error' | 'warning' | 'info';

/** Numeric rank for severity comparison; higher = more severe. */
export const SEVERITY_RANK: Record<RuleSeverity, number> = {
    error: 3,
    warning: 2,
    info: 1,
};

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
    /** Optional JSON Schema ref used by editors and loader validation. */
    $schema?: string;
    /** File-level default include patterns. */
    include?: string[];
    /** File-level default exclude patterns. */
    exclude?: string[];
    /** File-level default severity. */
    severity?: RuleSeverity;
    /** Rule definitions. */
    rules: ConstraintRule[];
    /** Custom capability modules contributed by this rule file (opt-in to load). */
    extensions?: PresetExtensions;
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
    /** Optional JSON Schema ref used by editors and loader validation. */
    $schema?: string;
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

/** Result of resolving effective fix authority for a rule. */
export interface EffectiveFix {
    /** Effective mode after all downgrades. */
    readonly mode: FixMode;
    /** Optional replacement text configured by the rule author. */
    readonly replacement?: string;
    /** Optional provider-specific parameters. */
    readonly params?: Record<string, unknown>;
}

/** Input passed to a rule fixer provider. */
export interface RuleFixerInput {
    /** Rule that produced the findings. */
    readonly rule: ConstraintRule;
    /** Rule execution context. */
    readonly context: RuleContext;
    /** Findings emitted for this rule. */
    readonly findings: ConstraintFinding[];
    /** Effective fix metadata after authority enforcement. */
    readonly fix: EffectiveFix;
}

/** Provider that turns findings into byte-range fixes. */
export interface RuleFixerProvider {
    /** Produce fixes for mechanically fixable findings. */
    createFixes(input: RuleFixerInput): Fix[] | Promise<Fix[]>;
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
    // Severity is intentionally NOT defaulted here: an omitted rule severity must
    // stay absent at parse time so the loader can apply the file-level default
    // (`rule.severity ?? file.severity ?? 'error'`). Normalization always fills it.
    severity: z.enum(['error', 'warning', 'info']).optional(),
    evaluator: z.object({
        type: z.string().min(1),
        config: z.record(z.string(), z.unknown()).optional(),
    }),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    fix: RuleFixConfigSchema.optional(),
});

/**
 * A relative module path a preset or rule file may load as an extension.
 *
 * Rejects absolute paths and `..` traversal: extension declarations are data, and a
 * path that escapes the declaring file's directory is a trust-boundary violation even
 * when extension loading is explicitly allowed. The actual guard is the shared
 * `assertRelativeExtensionPath` (ADR-010) so schema-time validation here and load-time
 * validation in the shared loader use one source of truth.
 */
const relativeExtensionPath = z
    .string()
    .min(1)
    .superRefine((value, ctx) => {
        try {
            assertRelativeExtensionPath(value);
        } catch (error) {
            ctx.addIssue({
                code: 'custom',
                message: error instanceof Error ? error.message : 'invalid extension path',
            });
        }
    });

/**
 * Shared zod schema for an `extensions` block, used by both preset and rule-file
 * schemas so they validate identically. `.strict()` makes a typo'd or misplaced key
 * a hard error rather than a silently-ignored field.
 */
export const ExtensionsSchema = z
    .object({
        resolvers: z.array(relativeExtensionPath).optional(),
        evaluators: z.array(relativeExtensionPath).optional(),
        fixers: z.array(relativeExtensionPath).optional(),
        formatters: z.array(relativeExtensionPath).optional(),
    })
    .strict();

/** Zod schema for a constraint rule file. */
export const ConstraintRuleFileSchema = z.object({
    $schema: z.string().optional(),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    severity: z.enum(['error', 'warning', 'info']).optional(),
    rules: z.array(ConstraintRuleSchema),
    extensions: ExtensionsSchema.optional(),
});

/** Zod schema for a preset definition. */
export const PresetDefinitionSchema = z.object({
    $schema: z.string().optional(),
    name: z.string().min(1),
    extends: z.array(z.string()).default([]),
    disable: z.array(z.string()).optional(),
    overrides: z
        .record(z.string(), z.object({ fix: z.object({ mode: z.enum(['none', 'suggest', 'auto']) }).optional() }))
        .optional(),
    extensions: ExtensionsSchema.optional(),
});
