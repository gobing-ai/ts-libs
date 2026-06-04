import { joinPath, NodeFileSystem } from '@gobing-ai/ts-runtime';
import {
    type ConstraintRule,
    createFinding,
    type RuleContext,
    type RuleEvaluationResult,
    type RuleEvaluator,
} from '../types';

/**
 * Evaluates JSON schema artifact files for structural integrity.
 *
 * Pure JS — no subprocess. Validates JSON validity, title, required properties,
 * `$defs` / `definitions` entries, and the presence of a top-level `required` array.
 *
 * ## Options (in `evaluator.config`)
 * - `file` — path to the JSON file relative to the workdir (required).
 * - `requiredTitle` — expected `title` value (optional).
 * - `requiredProperties` — top-level `properties` keys that must exist (optional).
 * - `requiredDefs` — `$defs` or `definitions` keys that must exist (optional).
 * - `requireRequiredArray` — enforce that `required` is a non-empty array (default: `false`).
 */
export class SchemaArtifactEvaluator implements RuleEvaluator {
    private readonly fs: NodeFileSystem;

    constructor() {
        this.fs = new NodeFileSystem();
    }

    /** Evaluate the configured JSON schema artifact. */
    async evaluate(rule: ConstraintRule, context: RuleContext): Promise<RuleEvaluationResult> {
        const config = rule.evaluator.config ?? {};
        const file = config.file;
        if (typeof file !== 'string' || file.length === 0) {
            throw new Error('schema-artifact evaluator requires string config "file"');
        }

        const requiredTitle = typeof config.requiredTitle === 'string' ? config.requiredTitle : undefined;
        const requiredProperties = stringArray(config.requiredProperties);
        const requiredDefs = stringArray(config.requiredDefs);
        const requireRequiredArray = config.requireRequiredArray === true;

        // Check existence.
        const absolutePath = joinPath(context.workdir, file);
        const exists = await this.fs.exists(absolutePath);
        if (!exists) {
            return {
                findings: [
                    createFinding(rule, 'schema artifact not found', file, {
                        code: 'schema-artifact:missing',
                    }),
                ],
                fixes: [],
            };
        }

        // Read and parse.
        let schema: Record<string, unknown>;
        try {
            const raw = await this.fs.readFile(absolutePath);
            schema = JSON.parse(raw) as Record<string, unknown>;
        } catch (err) {
            return {
                findings: [
                    createFinding(rule, `invalid JSON: ${(err as Error).message}`, file, {
                        code: 'schema-artifact:invalid',
                    }),
                ],
                fixes: [],
            };
        }

        const findings = [];

        // Validate title.
        if (requiredTitle !== undefined && schema.title !== requiredTitle) {
            findings.push(
                createFinding(
                    rule,
                    `${file} title expected '${requiredTitle}', got '${(schema.title as string | undefined) ?? '(missing)'}'`,
                    file,
                    { code: 'schema-artifact:violation' },
                ),
            );
        }

        // Validate required array.
        if (requireRequiredArray && !Array.isArray(schema.required)) {
            findings.push(
                createFinding(rule, `${file} missing 'required' array at top level`, file, {
                    code: 'schema-artifact:violation',
                }),
            );
        }

        // Validate properties.
        if (requiredProperties !== undefined) {
            const props = schema.properties as Record<string, unknown> | undefined;
            for (const prop of requiredProperties) {
                if (!props || !(prop in props)) {
                    findings.push(
                        createFinding(rule, `${file} missing properties.${prop}`, file, {
                            code: 'schema-artifact:violation',
                        }),
                    );
                }
            }
        }

        // Validate $defs / definitions.
        if (requiredDefs !== undefined) {
            const defs =
                (schema.$defs as Record<string, unknown> | undefined) ??
                (schema.definitions as Record<string, unknown> | undefined);
            for (const def of requiredDefs) {
                if (!defs || !(def in defs)) {
                    findings.push(
                        createFinding(rule, `${file} missing $defs.${def}`, file, {
                            code: 'schema-artifact:violation',
                        }),
                    );
                }
            }
        }

        return { findings, fixes: [] };
    }
}

/** Return a string array if value is a string array, otherwise undefined. */
function stringArray(value: unknown): string[] | undefined {
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : undefined;
}
