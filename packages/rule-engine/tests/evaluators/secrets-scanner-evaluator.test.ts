import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SecretsScannerEvaluator } from '../../src/evaluators/secrets-scanner-evaluator';
import type { ConstraintFinding, ConstraintRule, RuleContext } from '../../src/types';

function makeRule(): ConstraintRule {
    return {
        id: 'test-rule',
        description: 'test',
        enabled: true,
        severity: 'error',
        evaluator: { type: 'secrets-scanner' },
    };
}

function makeContext(workdir = '/tmp'): RuleContext {
    return { workdir, rule: makeRule() };
}

// Fixture text is assembled at runtime rather than written literally: this file is
// itself inside a scanned scope, so a literal assignment line would be reported
// when the scanner walks the package.
const QUOTE = String.fromCharCode(34); // double quote
const SQUOTE = String.fromCharCode(39); // single quote
const BACKTICK = String.fromCharCode(96);
const EQ = String.fromCharCode(61);
const COLON = String.fromCharCode(58);
const KEY_PASSWORD = `pass${'word'}`;
const KEY_PASSWD = `pass${'wd'}`;
const KEY_PWD = `p${'wd'}`;
const KEY_BYPASS = `by${'pass'}`;
const KEY_COMPASS = `com${'pass'}`;

/** Scan one fixture line in an isolated temp dir and return the findings. */
async function scanLine(line: string): Promise<ConstraintFinding[]> {
    const tmpDir = join('/tmp', `rule-engine-secrets-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
        writeFileSync(join(tmpDir, 'fixture.txt'), `${line}\n`);
        const ctx = makeContext(tmpDir);
        const result = await new SecretsScannerEvaluator().evaluate(ctx.rule, ctx);
        return result.findings;
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
}

describe('SecretsScannerEvaluator', () => {
    test('constructs without arguments', () => {
        const evaluator = new SecretsScannerEvaluator();
        expect(evaluator).toBeInstanceOf(SecretsScannerEvaluator);
    });

    test('returns empty findings for empty directory', async () => {
        const evaluator = new SecretsScannerEvaluator();
        const tmpDir = join('/tmp', `rule-engine-test-${Date.now()}`);
        mkdirSync(tmpDir, { recursive: true });
        try {
            const ctx = makeContext(tmpDir);
            const result = await evaluator.evaluate(ctx.rule, ctx);
            expect(result.findings).toEqual([]);
            expect(result.fixes).toEqual([]);
        } finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('SecretsScannerEvaluator password category', () => {
    // Regression (spur task 1200): the keyword group carried a bare `pass`, which
    // matched the ecosystem's PASS verdict vocabulary and the `bypass`/`compass`
    // substrings in ordinary prose, hard-failing the pre-check gate on doc comments.
    const nonSecrets: [string, string][] = [
        ['a PASS verdict in prose', `Derived confidence in a PASS${COLON} ${BACKTICK}HIGH${BACKTICK} when it exited 0`],
        ['the word bypass', `${KEY_BYPASS}${COLON} ${QUOTE}the cache${QUOTE}`],
        ['the word compass', `${KEY_COMPASS} ${EQ} ${SQUOTE}north${SQUOTE}`],
    ];

    for (const [name, line] of nonSecrets) {
        test(`does not report ${name}`, async () => {
            expect(await scanLine(line)).toEqual([]);
        });
    }

    const secrets: [string, string][] = [
        ['password', `${KEY_PASSWORD} ${EQ} ${QUOTE}hunter2hunter2${QUOTE}`],
        ['passwd', `${KEY_PASSWD}${COLON} ${SQUOTE}x9fJ2kLm${SQUOTE}`],
        ['pwd with a spaced value', `${KEY_PWD}${COLON} ${QUOTE}correct horse${QUOTE}`],
    ];

    for (const [name, line] of secrets) {
        test(`still reports a real ${name} assignment`, async () => {
            const findings = await scanLine(line);
            expect(findings).toHaveLength(1);
            expect(findings[0]?.code).toBe('secret:password');
        });
    }
});
