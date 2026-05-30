import type { ProcessExecutor } from '@gobing-ai/ts-runtime';
import { AgentDetectionEvaluator } from '../evaluators/agent-detection-evaluator';
import { ExitCodeEvaluator } from '../evaluators/exit-code-evaluator';
import { ForbiddenImportEvaluator } from '../evaluators/forbidden-import-evaluator';
import { PathEvaluator } from '../evaluators/path-evaluator';
import { RegexEvaluator } from '../evaluators/regex-evaluator';
import { SecretsScannerEvaluator } from '../evaluators/secrets-scanner-evaluator';
import { JsonFormatter } from '../formatters/json';
import { TextFormatter } from '../formatters/text';
import type { RuleEngineHost } from './rule-engine-host';

/** Register bundled evaluators and formatters on a host. */
export function registerBuiltins(host: RuleEngineHost, executor?: ProcessExecutor): void {
    const regex = new RegexEvaluator();
    const path = new PathEvaluator();
    host.evaluators.register('regex', regex, 'builtin');
    host.evaluators.register('rg', regex, 'builtin');
    host.evaluators.register('path', path, 'builtin');
    host.evaluators.register('file-exist', path, 'builtin');
    host.evaluators.register('forbidden-import', new ForbiddenImportEvaluator(), 'builtin');
    host.evaluators.register('exit-code', new ExitCodeEvaluator(executor), 'builtin');
    host.evaluators.register('secrets-scanner', new SecretsScannerEvaluator(), 'builtin');
    host.evaluators.register('agent-detection', new AgentDetectionEvaluator(), 'builtin');
    host.formatters.register('text', new TextFormatter(), 'builtin');
    host.formatters.register('json', new JsonFormatter(), 'builtin');
}
