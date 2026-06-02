import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIdentityPreamble, getGitContext } from '../src';

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
    test('returns branch and dirty count for a git workspace when git is available', () => {
        const dir = mkdtempSync(join(tmpdir(), 'ai-runner-git-'));
        if (Bun.which('git') === null) {
            expect(getGitContext(dir)).toBeNull();
            return;
        }
        Bun.spawnSync({ cmd: ['git', '-C', dir, 'init'], stdout: 'pipe', stderr: 'pipe' });
        Bun.spawnSync({ cmd: ['git', '-C', dir, 'checkout', '-b', 'team-mode'], stdout: 'pipe', stderr: 'pipe' });
        writeFileSync(join(dir, 'file.txt'), 'dirty');
        const context = getGitContext(dir);
        expect(context).toContain('branch: team-mode');
        expect(context).toContain('dirty: 1 files');
    });
});
