import { describe, expect, test } from 'bun:test';
import {
    capabilityInvocationId,
    extractNestedExecCommandLiterals,
    matchCapabilityOrigin,
    parseLiteralReadTargets,
    validateCapabilityOrigins,
} from '../src/capability';
import { HistoryImportError } from '../src/errors';
import type { CapabilityOrigin } from '../src/types';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function origin(overrides: Partial<CapabilityOrigin> = {}): CapabilityOrigin {
    return {
        source: 'claude',
        skillName: 'deploy',
        artifactDigest: DIGEST_A,
        capabilityKind: 'skill',
        originIdentity: 'plugin:deploy',
        ...overrides,
    };
}

describe('validateCapabilityOrigins', () => {
    test('accepts undefined and well-formed origins', () => {
        expect(validateCapabilityOrigins(undefined)).toEqual([]);
        const valid = [origin(), origin({ skillPath: '/x/SKILL.md', capabilityKind: 'command' })];
        expect(validateCapabilityOrigins(valid)).toEqual(valid);
    });

    test('rejects a non-array input', () => {
        expect(() => validateCapabilityOrigins({} as unknown as CapabilityOrigin[])).toThrow(
            'capabilityOrigins must be an array',
        );
    });

    const invalid: Array<[string, unknown, string]> = [
        ['non-object entry', null, 'entry must be an object'],
        ['blank source', origin({ source: ' ' }), 'source must be a non-empty string'],
        ['blank skillName', origin({ skillName: '' }), 'skillName must be a non-empty string'],
        ['bad digest', origin({ artifactDigest: 'ABC' }), 'artifactDigest must be a 64-character'],
        ['unknown kind', origin({ capabilityKind: 'tool' as never }), "capabilityKind must be one of 'command'"],
        ['blank originIdentity', origin({ originIdentity: '' }), 'originIdentity must be a non-empty string'],
        ['blank skillPath', origin({ skillPath: ' ' }), 'skillPath must be a non-empty string when present'],
    ];
    for (const [name, entry, message] of invalid) {
        test(`rejects ${name} with an indexed HistoryImportError`, () => {
            const run = () => validateCapabilityOrigins([origin(), entry as CapabilityOrigin]);
            expect(run).toThrow(HistoryImportError);
            expect(run).toThrow(`capabilityOrigins[1]: ${message}`);
        });
    }
});

describe('matchCapabilityOrigin', () => {
    test('no candidate for the source/name resolves to unknown without conflict', () => {
        expect(matchCapabilityOrigin([origin()], 'codex', 'deploy', {})).toEqual({ origin: undefined, conflict: null });
    });

    test('a single name match without observables is the origin', () => {
        const only = origin();
        expect(matchCapabilityOrigin([only], 'claude', 'deploy', {}).origin).toBe(only);
    });

    test('path narrows candidates before the digest filter', () => {
        const atA = origin({ skillPath: '/a/SKILL.md' });
        const atB = origin({ skillPath: '/b/SKILL.md', artifactDigest: DIGEST_B });
        const match = matchCapabilityOrigin([atA, atB], 'claude', 'deploy', { skillPath: '/b/SKILL.md' });
        expect(match).toEqual({ origin: atB, conflict: null });
    });

    test('an unknown observed path keeps all name candidates', () => {
        const atA = origin({ skillPath: '/a/SKILL.md' });
        const atB = origin({ skillPath: '/b/SKILL.md', artifactDigest: DIGEST_B });
        const match = matchCapabilityOrigin([atA, atB], 'claude', 'deploy', {
            skillPath: '/c/SKILL.md',
            artifactDigest: DIGEST_B,
        });
        expect(match).toEqual({ origin: atB, conflict: null });
    });

    test('several origins agreeing on the digest is a conflict', () => {
        const match = matchCapabilityOrigin([origin(), origin({ originIdentity: 'other' })], 'claude', 'deploy', {
            artifactDigest: DIGEST_A,
        });
        expect(match.origin).toBeUndefined();
        expect(match.conflict).toContain('2 origins agree on digest');
    });

    test('a digest that matches no candidate is a conflict', () => {
        const match = matchCapabilityOrigin([origin()], 'claude', 'deploy', { artifactDigest: DIGEST_B });
        expect(match.origin).toBeUndefined();
        expect(match.conflict).toContain('does not match the supplied origin');
    });

    test('several candidates without distinguishing evidence is a conflict', () => {
        const match = matchCapabilityOrigin([origin(), origin({ artifactDigest: DIGEST_B })], 'claude', 'deploy', {});
        expect(match.conflict).toContain('2 origins match');
    });
});

describe('capabilityInvocationId', () => {
    test('is stable for equal parts and distinct when any part changes', () => {
        const base = { source: 'claude', sessionId: 's1', kind: 'call' as const, id: 'c1' };
        expect(capabilityInvocationId(base)).toBe(capabilityInvocationId({ ...base }));
        expect(capabilityInvocationId(base)).toMatch(/^[0-9a-f]{64}$/);
        expect(capabilityInvocationId({ ...base, id: 'c2' })).not.toBe(capabilityInvocationId(base));
        expect(capabilityInvocationId({ ...base, ordinal: 0 })).not.toBe(capabilityInvocationId(base));
    });
});

describe('parseLiteralReadTargets', () => {
    test('accepts literal cat and sed print forms', () => {
        expect(parseLiteralReadTargets('cat -n -- /p/a/SKILL.md /p/README.md')).toEqual(['/p/a/SKILL.md']);
        expect(parseLiteralReadTargets("sed -n '1,200p' '/p/b/SKILL.md'")).toEqual(['/p/b/SKILL.md']);
        expect(parseLiteralReadTargets("sed --quiet -- 1p '5,$p' /p/c/SKILL.md")).toEqual(['/p/c/SKILL.md']);
    });

    test('splits at ; && || | and & separators', () => {
        expect(parseLiteralReadTargets('cd /p; cat a/SKILL.md && cat b/SKILL.md || true')).toEqual([
            'a/SKILL.md',
            'b/SKILL.md',
        ]);
        expect(parseLiteralReadTargets('cat a/SKILL.md | head & cat "b c/SKILL.md"')).toEqual([
            'a/SKILL.md',
            'b c/SKILL.md',
        ]);
        // Separators inside quotes are literal, not segment breaks.
        expect(parseLiteralReadTargets("cat 'x;y/SKILL.md'")).toEqual(['x;y/SKILL.md']);
    });

    test('rejects non-literal or out-of-grammar commands', () => {
        for (const command of [
            '',
            '   ',
            'cat $HOME/SKILL.md',
            'cat `pwd`/SKILL.md',
            'cat "$DIR/SKILL.md"',
            'cat a\\ b/SKILL.md',
            'cat a/SKILL.md > out',
            'cat "unterminated/SKILL.md',
            '# cat a/SKILL.md',
            'sed -i 1p a/SKILL.md',
            'sed -n a/SKILL.md',
            'sed 1p a/SKILL.md',
            'head a/SKILL.md',
        ]) {
            expect(parseLiteralReadTargets(command)).toEqual([]);
        }
        expect(parseLiteralReadTargets(42 as unknown as string)).toEqual([]);
    });

    test('ignores non-SKILL.md targets', () => {
        expect(parseLiteralReadTargets('cat a/SKILL.md.bak a/skills/')).toEqual([]);
    });
});

describe('extractNestedExecCommandLiterals', () => {
    test('extracts statement-start literals with extra literal keys and unescapes them', () => {
        const payload = [
            '    tools.exec_command({cmd: "cat a/SKILL.md", workdir: "/p", timeout: 10, tty: false})',
            "{ tools.exec_command({ cmd: 'echo \\'hi\\'\\n' }) }",
        ].join('\n');
        expect(extractNestedExecCommandLiterals(payload)).toEqual(['cat a/SKILL.md', "echo 'hi'\n"]);
    });

    test('skips quoted, commented and non-literal occurrences', () => {
        const payload = [
            'const s = "tools.exec_command({cmd: \'cat x\'})";',
            '// tools.exec_command({cmd: "cat line-comment"})',
            '/* tools.exec_command({cmd: "cat block-1"})',
            '   tools.exec_command({cmd: "cat block-2"}) */ tools.exec_command({cmd: "after-block"})',
            'tools.exec_command({cmd: "kept"}) /* tools.exec_command({cmd: "inline-comment"}) */',
            'tools.exec_command({cmd: "open"}) /* unterminated',
            'tools.exec_command({cmd: "still-in-block"})',
            '*/',
            'tools.exec_command({cmd: `template`})',
            'tools.exec_command({cmd: "a" + b})',
        ].join('\n');
        expect(extractNestedExecCommandLiterals(payload)).toEqual(['after-block', 'kept', 'open']);
    });

    test('returns nothing for blank or non-string payloads', () => {
        expect(extractNestedExecCommandLiterals('  ')).toEqual([]);
        expect(extractNestedExecCommandLiterals(undefined as unknown as string)).toEqual([]);
    });
});
