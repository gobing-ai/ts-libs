import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessExecutor, SyncProcessExecutor } from '@gobing-ai/ts-runtime';
import { buildIdentityPreamble, getGitContext, getGitContextSync } from '../src';

describe('buildIdentityPreamble', () => {
    test('renders solo agent with communication instructions', () => {
        const text = buildIdentityPreamble({ agentId: 'coder', agentType: 'codex', workspace: '/repo' });
        expect(text).toContain('You are agent `coder` (codex) in workspace `/repo`.');
        expect(text).toContain('spur message send');
        expect(text).not.toContain('Peer agents');
    });

    test('renders task, purpose, system prompt, peers, git context and guardrails', () => {
        const text = buildIdentityPreamble({
            agentId: 'coder',
            agentType: 'codex',
            workspace: 'spur-new',
            taskId: '0005',
            taskTitle: 'Implement team mode',
            purpose: 'Implement code',
            systemPrompt: 'Follow repository rules.',
            peers: [
                { id: 'planner', type: 'claude', purpose: 'Plan work' },
                { id: 'reviewer', type: 'codex' },
            ],
            gitBranch: 'team-mode',
            gitDirty: true,
            guardrails: ['Do not commit.'],
        });
        expect(text).toContain('Your current task: #0005 — Implement team mode.');
        expect(text).toContain('Your purpose: Implement code.');
        expect(text).toContain('Follow repository rules.');
        expect(text).toContain('- `planner` (claude) — Plan work');
        expect(text).toContain('- `reviewer` (codex) — (no purpose set)');
        expect(text).toContain('branch: team-mode');
        expect(text).toContain('dirty: true');
        expect(text).toContain('- Do not commit.');
    });

    test('empty peers and missing optional fields are omitted', () => {
        const text = buildIdentityPreamble({ agentId: 'solo', agentType: 'pi', workspace: 'x', peers: [] });
        expect(text).not.toContain('Peer agents');
        expect(text).not.toContain('Your current task');
    });
});

describe('getGitContext', () => {
    test('resolves null when git fails through the async ProcessExecutor', async () => {
        const executor: ProcessExecutor = {
            run: async ({ command, args }) => ({
                command,
                args: args ?? [],
                exitCode: 1,
                stdout: '',
                stderr: 'git: command not found',
                durationMs: 1,
            }),
            runStreaming: () => {
                throw new Error('not used');
            },
        };

        expect(await getGitContext('/repo', executor)).toBeNull();
    });

    test('resolves a git context block with branch and dirty count for a real workspace', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'ai-runner-git-'));
        if (Bun.which('git') === null) {
            expect(await getGitContext(dir)).toBeNull();
            return;
        }
        Bun.spawnSync({ cmd: ['git', '-C', dir, 'init'], stdout: 'pipe', stderr: 'pipe' });
        Bun.spawnSync({ cmd: ['git', '-C', dir, 'checkout', '-b', 'team-mode'], stdout: 'pipe', stderr: 'pipe' });
        writeFileSync(join(dir, 'file.txt'), 'dirty');
        const context = await getGitContext(dir);
        expect(context).toContain('branch: team-mode');
        expect(context).toContain('dirty: 1 files');
    });

    test('resolves a block containing the branch when a fake async executor reports main', async () => {
        const calls: string[][] = [];
        const executor: ProcessExecutor = {
            run: async ({ command, args }) => {
                calls.push(args ?? []);
                const argv = args ?? [];
                const stdout = argv.includes('--show-current') ? 'main\n' : ' M file.ts\n';
                return { command, args: argv, exitCode: 0, stdout, stderr: '', durationMs: 0 };
            },
            runStreaming: () => {
                throw new Error('not used');
            },
        };

        const context = await getGitContext('/repo', executor);
        expect(context).toContain('branch: main');
        expect(context).toContain('dirty: 1 files');
        // both git invocations go through executor.run (async), never runSync
        expect(calls).toHaveLength(2);
    });
});

describe('getGitContextSync', () => {
    test('returns null synchronously when a fake SyncProcessExecutor fails', () => {
        const executor: SyncProcessExecutor = {
            runSync: ({ command, args }) => ({
                command,
                args: args ?? [],
                exitCode: 1,
                stdout: '',
                stderr: 'git: command not found',
                durationMs: 1,
            }),
        };

        expect(getGitContextSync('/repo', executor)).toBeNull();
    });

    test('returns a git context block synchronously when a fake SyncProcessExecutor succeeds', () => {
        const executor: SyncProcessExecutor = {
            runSync: ({ command, args }) => {
                const argv = args ?? [];
                const stdout = argv.includes('--show-current') ? 'main\n' : ' M file.ts\n';
                return { command, args: argv, exitCode: 0, stdout, stderr: '', durationMs: 0 };
            },
        };

        const context = getGitContextSync('/repo', executor);
        expect(context).toContain('branch: main');
        expect(context).toContain('dirty: 1 files');
    });
});
