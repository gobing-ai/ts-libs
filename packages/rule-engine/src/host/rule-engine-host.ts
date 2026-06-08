import { CapabilityRegistry } from '@gobing-ai/ts-runtime/extension';
import type { TestPathResolver } from '../resolvers/test-path-resolver';
import type { ResultFormatter, RuleEvaluator, RuleFixerProvider } from '../types';

/** Host container for rule-engine capabilities. */
export class RuleEngineHost {
    /** Evaluator registry keyed by evaluator type. */
    readonly evaluators: CapabilityRegistry<RuleEvaluator>;
    /** Formatter registry keyed by formatter name. */
    readonly formatters: CapabilityRegistry<ResultFormatter>;
    /** Test-path resolver registry keyed by language name. */
    readonly resolvers: CapabilityRegistry<TestPathResolver>;
    /** Fixer provider registry keyed by evaluator type. */
    readonly fixers: CapabilityRegistry<RuleFixerProvider>;

    constructor() {
        this.evaluators = new CapabilityRegistry<RuleEvaluator>('evaluator');
        this.formatters = new CapabilityRegistry<ResultFormatter>('formatter');
        this.resolvers = new CapabilityRegistry<TestPathResolver>('resolver');
        this.fixers = new CapabilityRegistry<RuleFixerProvider>('fixer');
    }
}
