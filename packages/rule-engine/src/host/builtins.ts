import type { ProcessExecutor } from '@gobing-ai/ts-runtime';
import { AgentDetectionEvaluator } from '../evaluators/agent-detection-evaluator';
import { CoverageGateEvaluator } from '../evaluators/coverage-gate-evaluator';
import { ExitCodeEvaluator } from '../evaluators/exit-code-evaluator';
import { ForbiddenImportEvaluator } from '../evaluators/forbidden-import-evaluator';
import { ImportBoundaryEvaluator } from '../evaluators/import-boundary-evaluator';
import { PathEvaluator } from '../evaluators/path-evaluator';
import { RegexEvaluator } from '../evaluators/regex-evaluator';
import { RipgrepEvaluator } from '../evaluators/ripgrep-evaluator';
import { SchemaArtifactEvaluator } from '../evaluators/schema-artifact-evaluator';
import { SecretsScannerEvaluator } from '../evaluators/secrets-scanner-evaluator';
import { SgEvaluator } from '../evaluators/sg-evaluator';
import { TestLocationEvaluator } from '../evaluators/test-location-evaluator';
import { TsdocExportEvaluator } from '../evaluators/tsdoc-export-evaluator';
import { JsonFormatter } from '../formatters/json';
import { TextFormatter } from '../formatters/text';
import {
    GoTestPathResolver,
    PythonTestPathResolver,
    RustTestPathResolver,
    TypeScriptTestPathResolver,
} from '../resolvers/test-path-resolver';
import type { RuleEngineHost } from './rule-engine-host';

/** Register bundled evaluators and formatters on a host. */
export function registerBuiltins(host: RuleEngineHost, executor?: ProcessExecutor): void {
    const path = new PathEvaluator();
    // `regex` = JS RegExp engine; `rg` = real ripgrep engine (ReDoS-immune, prunes during
    // traversal). The two are honestly named distinct engines, not aliases.
    host.evaluators.register('regex', new RegexEvaluator(), 'builtin');
    host.evaluators.register('rg', new RipgrepEvaluator(executor), 'builtin');
    host.evaluators.register('path', path, 'builtin');
    host.evaluators.register('file-exist', path, 'builtin');
    host.evaluators.register('forbidden-import', new ForbiddenImportEvaluator(), 'builtin');
    host.evaluators.register('exit-code', new ExitCodeEvaluator(executor), 'builtin');
    host.evaluators.register('secrets-scanner', new SecretsScannerEvaluator(), 'builtin');
    host.evaluators.register('agent-detection', new AgentDetectionEvaluator(), 'builtin');
    host.evaluators.register('coverage-gate', new CoverageGateEvaluator(), 'builtin');
    host.evaluators.register('tsdoc-export', new TsdocExportEvaluator(), 'builtin');
    host.resolvers.register('typescript', new TypeScriptTestPathResolver(), 'builtin');
    host.resolvers.register('python', new PythonTestPathResolver(), 'builtin');
    host.resolvers.register('go', new GoTestPathResolver(), 'builtin');
    host.resolvers.register('rust', new RustTestPathResolver(), 'builtin');
    host.evaluators.register('test-location', new TestLocationEvaluator(host.resolvers), 'builtin');
    host.evaluators.register('sg', new SgEvaluator(executor), 'builtin');
    host.evaluators.register('schema-artifact', new SchemaArtifactEvaluator(), 'builtin');
    host.evaluators.register('import-boundary', new ImportBoundaryEvaluator(), 'builtin');
    host.formatters.register('text', new TextFormatter(), 'builtin');
    host.formatters.register('json', new JsonFormatter(), 'builtin');
}
