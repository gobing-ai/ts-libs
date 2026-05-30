import type { ResultFormatter, RuleEvaluator } from '../types';
import { CapabilityRegistry } from './capability-registry';

/** Host container for rule-engine capabilities. */
export class RuleEngineHost {
    /** Evaluator registry keyed by evaluator type. */
    readonly evaluators: CapabilityRegistry<RuleEvaluator>;
    /** Formatter registry keyed by formatter name. */
    readonly formatters: CapabilityRegistry<ResultFormatter>;

    constructor() {
        this.evaluators = new CapabilityRegistry<RuleEvaluator>('evaluator');
        this.formatters = new CapabilityRegistry<ResultFormatter>('formatter');
    }
}
