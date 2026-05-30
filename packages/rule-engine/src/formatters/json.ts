import type { ResultFormatter, RuleEngineResult } from '../types';

/** JSON formatter for rule-engine results. */
export class JsonFormatter implements ResultFormatter {
    constructor() {}

    /** Format the full result as pretty JSON. */
    format(result: RuleEngineResult): string {
        return JSON.stringify(result, null, 2);
    }
}
