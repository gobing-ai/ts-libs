import type { Desc, Json } from '@gobing-ai/ts-ai-runner';
import { z } from 'zod';

/**
 * Zod schema for the decision catalog — the runtime source of truth (task 0089 R4).
 * `schemas/decision-catalog.schema.json` describes the same shape for editors and
 * standard validators; strictness (`additionalProperties: false` / `.strict()`) applies
 * at every level. Cross-field semantics (fallback vocabulary, template refs, defaults,
 * reserved `instructions`) are enforced by the loader in `catalog.ts`.
 */

export const DECISION_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
/** Declared parameter names: lowercase-start identifier, no hyphens. */
export const PARAM_NAME_PATTERN = /^[a-z][a-zA-Z0-9_]*$/;
/** Maker registry names: lowercase kebab-case. */
export const MAKER_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

const JsonValueSchema: z.ZodType<Json> = z.lazy(() =>
    z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.null(),
        z.array(JsonValueSchema),
        z.record(z.string(), JsonValueSchema),
    ]),
);

/** A Jev entry: string, JSON object, JSON array, or null ("left undescribed"). */
const JevEntrySchema: z.ZodType<Desc> = z.lazy(() =>
    z.union([z.string(), z.null(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]),
);

const ParamTypeSchema = z.enum(['string', 'number', 'boolean', 'enum', 'json']);

/** Full parameter form; the shorthand is the bare {@link ParamTypeSchema} string. */
const FullParamSchema = z
    .object({
        type: ParamTypeSchema,
        default: z.unknown().optional(),
        values: z.array(z.string()).min(1).optional(),
        description: z.string().optional(),
    })
    .strict();

/** Authored parameter form: the bare type shorthand or the full strict object. */
export const ParamSchema = z.union([ParamTypeSchema, FullParamSchema]);

const NoulCriteriaSchema = z.object({ true: JevEntrySchema.optional(), false: JevEntrySchema.optional() }).strict();
const ChoiceCriteriaSchema = z.record(z.string().min(1), JevEntrySchema);
const ScoreCriteriaSchema = z.array(JevEntrySchema);

/** One authored decision (strict; cross-field semantics are enforced by the loader in `catalog.ts`). */
export const DecisionSchema = z
    .object({
        type: z.enum(['choice', 'score', 'noul']),
        description: z.string().optional(),
        instructions: JevEntrySchema.optional(),
        parameters: z.record(z.string().regex(PARAM_NAME_PATTERN), ParamSchema).optional(),
        criteria: z.union([NoulCriteriaSchema, ChoiceCriteriaSchema, ScoreCriteriaSchema]).optional(),
        fallback: z.union([z.string(), z.number(), z.boolean()]),
        minConfidence: z.number().min(0).max(1).optional(),
        maker: z.string().regex(MAKER_NAME_PATTERN).optional(),
        model: z.string().optional(),
    })
    .strict();

/** Whole-catalog schema (strict; `version` must be 1 and at least one decision is required). */
export const DecisionCatalogSchema = z
    .object({
        $schema: z.string().optional(),
        version: z.literal(1),
        defaults: z
            .object({
                maker: z.string().regex(MAKER_NAME_PATTERN).optional(),
                model: z.string().optional(),
                minConfidence: z.number().min(0).max(1).optional(),
            })
            .strict()
            .optional(),
        decisions: z.record(z.string().regex(DECISION_ID_PATTERN), DecisionSchema),
    })
    .strict()
    .refine((catalog) => Object.keys(catalog.decisions).length >= 1, {
        message: 'decisions must declare at least one decision',
    });

/** Inferred shape of a validated catalog body. */
export type ParsedCatalog = z.infer<typeof DecisionCatalogSchema>;
/** Inferred shape of one validated decision body. */
export type ParsedDecision = z.infer<typeof DecisionSchema>;
/** Inferred shape of the full (non-shorthand) parameter form. */
export type ParsedParam = z.infer<typeof FullParamSchema>;
/** The whole parameter union: the shorthand type string or the full form. */
export type ParsedParamUnion = z.infer<typeof ParamSchema>;
