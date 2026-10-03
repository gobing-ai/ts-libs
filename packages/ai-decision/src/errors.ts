/**
 * DecisionCatalogError — task 0089 — load-time failure for a decision catalog.
 * Names the source and, when known, the decision id and field, so an
 * inconsistent catalog points straight at the offending key.
 */
export class DecisionCatalogError extends Error {
    constructor(
        message: string,
        readonly source: string,
        readonly decisionId?: string,
        readonly field?: string,
    ) {
        super(message);
        this.name = 'DecisionCatalogError';
    }
}

/**
 * DecisionRegistryError — task 0091 — invalid DecisionMakerRegistry use: a name
 * that fails `^[a-z][a-z0-9-]*$` or a duplicate registration.
 */
export class DecisionRegistryError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DecisionRegistryError';
    }
}

/**
 * UnknownDecisionMakerError — task 0091 — resolve of a name that is not
 * registered. The `name` property carries the unknown maker name; the class is
 * identified via `instanceof`, because assigning `this.name` would clobber it.
 */
export class UnknownDecisionMakerError extends Error {
    constructor(
        message: string,
        override readonly name: string,
    ) {
        super(message);
    }
}

/**
 * UnknownDecisionError — task 0090 — decide/describe of a decision id that no
 * loaded catalog declares. A caller mistake: it throws instead of falling
 * back, before any backend call. The `decisionId` property carries the id; the
 * class is identified via `instanceof`, like UnknownDecisionMakerError.
 */
export class UnknownDecisionError extends Error {
    constructor(
        message: string,
        readonly decisionId: string,
    ) {
        super(message);
        this.name = 'UnknownDecisionError';
    }
}

/**
 * DecisionInputError — task 0089 R7 — violation of one decision's parameter
 * contract: unknown key, missing required parameter, or type mismatch.
 */
export class DecisionInputError extends Error {
    constructor(
        message: string,
        readonly decisionId: string,
        readonly param: string,
    ) {
        super(message);
        this.name = 'DecisionInputError';
    }
}
