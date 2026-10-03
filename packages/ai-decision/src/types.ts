import type { Desc, Json } from '@gobing-ai/ts-ai-runner';

/** Jev question types a decision can declare (task 0089 R4). */
export type DecisionType = 'choice' | 'score' | 'noul';

/** Declared parameter types; `enum` requires `values`, `json` accepts any JSON value. */
export type ParamType = 'string' | 'number' | 'boolean' | 'enum' | 'json';

/** One declared parameter, normalized from the shorthand (`name: type`) or full form. */
export interface DecisionParam {
    readonly name: string;
    readonly type: ParamType;
    /** True when authored without a `default` key: every call must supply it. */
    readonly required: boolean;
    /** Authored `default` value (may be null); defined exactly when not required. */
    readonly default?: Json;
    /** Accepted strings for `type: enum` (at least one). */
    readonly values?: readonly string[];
    readonly description?: string;
}

/** A criteria/instructions entry: description string, JSON object, JSON array, or null ("undescribed"). */
export type JevEntry = Desc;

/** Normalized criteria of a decision, shaped by its `type`. */
export type DecisionCriteria =
    | { readonly kind: 'choice'; readonly labels: Readonly<Record<string, JevEntry>> }
    | { readonly kind: 'score'; readonly levels: readonly JevEntry[] }
    | { readonly kind: 'noul'; readonly outcomes?: { readonly true?: JevEntry; readonly false?: JevEntry } };

/** One typed decision definition as produced by the loader. */
export interface DecisionDefinition {
    readonly id: string;
    readonly source: string;
    readonly type: DecisionType;
    /** Documentation only; never sent to the model. */
    readonly description?: string;
    /** Authored instructions template; {@link DEFAULT_INSTRUCTIONS_TEMPLATE} when absent. */
    readonly instructions: JevEntry;
    /** Declared parameters plus the implicit reserved `instructions` parameter. */
    readonly parameters: Readonly<Record<string, DecisionParam>>;
    readonly criteria: DecisionCriteria;
    readonly fallback: string | number | boolean;
    /** Overrides `defaults.minConfidence` (0..1). */
    readonly minConfidence?: number;
    /** Registry name, checked at hub load, not by the catalog loader. */
    readonly maker?: string;
    readonly model?: string;
}

/** Catalog-wide maker/model/minConfidence defaults; every key optional. */
export interface CatalogDefaults {
    readonly maker?: string;
    readonly model?: string;
    readonly minConfidence?: number;
}

/** A loaded catalog: typed definitions, all-or-nothing (task 0089 invariant). */
export interface DecisionCatalog {
    readonly source: string;
    readonly defaults: CatalogDefaults;
    readonly decisions: Readonly<Record<string, DecisionDefinition>>;
}

/** Fully resolved parameter values for one `decide` call, including `instructions`. */
export type ResolvedParams = Record<string, Json>;

/** The rendered Jev question for one decision, ready for the neutral surface. */
export type JevQuestion =
    | {
          readonly type: 'choice';
          readonly instructions: JevEntry;
          readonly criteria: Readonly<Record<string, JevEntry>>;
      }
    | { readonly type: 'score'; readonly instructions: JevEntry; readonly criteria: readonly JevEntry[] }
    | {
          readonly type: 'noul';
          readonly instructions: JevEntry;
          readonly criteria?: { readonly true?: JevEntry; readonly false?: JevEntry };
      };
