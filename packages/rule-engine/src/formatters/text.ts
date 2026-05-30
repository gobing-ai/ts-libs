import type { ResultFormatter, RuleEngineResult } from '../types';

/** Text formatter for human CLI output. */
export class TextFormatter implements ResultFormatter {
    constructor() {}

    /** Format findings as concise path-prefixed lines. */
    format(result: RuleEngineResult): string {
        if (result.findings.length === 0) return 'No rule findings.';
        return result.findings
            .map((finding) => {
                const location =
                    finding.filePath === null
                        ? '<workspace>'
                        : `${finding.filePath}${finding.line ? `:${finding.line}` : ''}`;
                return `${finding.severity.toUpperCase()} ${finding.ruleId} ${location} ${finding.message}`;
            })
            .join('\n');
    }
}
