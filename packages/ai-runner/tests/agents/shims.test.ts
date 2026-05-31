import { describe, expect, test } from 'bun:test';
import {
    AGENT_SHIMS,
    type AgentName,
    DISPLAY_ORDER,
    getAgentShim,
    isAgentName,
    TIER1_PRIORITY,
    TIER2_AGENTS,
} from '../../src/agents/shims';

describe('Agent shims', () => {
    test('isAgentName returns true for bundled agents and false for unknown', () => {
        expect(isAgentName('claude')).toBe(true);
        expect(isAgentName('codex')).toBe(true);
        expect(isAgentName('gemini')).toBe(true);
        expect(isAgentName('pi')).toBe(true);
        expect(isAgentName('opencode')).toBe(true);
        expect(isAgentName('antigravity')).toBe(true);
        expect(isAgentName('openclaw')).toBe(true);

        expect(isAgentName('')).toBe(false);
        expect(isAgentName('cursor')).toBe(false);
        expect(isAgentName('copilot')).toBe(false);
    });

    test('isAgentName narrows the type for valid AgentName values', () => {
        const candidate = 'pi';

        if (isAgentName(candidate)) {
            const shim = getAgentShim(candidate);
            expect(shim.name).toBe('pi');
        } else {
            // candidate is string here — unreachable for 'pi'
            expect.unreachable('pi should be a valid agent name');
        }
    });

    test('getAgentShim returns correct shim for every bundled agent', () => {
        const names = Object.keys(AGENT_SHIMS) as AgentName[];
        for (const name of names) {
            const shim = getAgentShim(name);
            expect(shim.name).toBe(name);
            expect(shim.command).toBeString();
            expect([1, 2]).toContain(shim.tier);
            expect(shim.getHelpCommand().command).toBe(shim.command);
            expect(shim.getVersionCommand().command).toBe(shim.command);
            expect(shim.getPromptCommand({ input: 'test' }).args).toBeArray();
        }
    });

    test('TIER2_AGENTS contains antigravity and openclaw', () => {
        expect(TIER2_AGENTS.has('antigravity')).toBe(true);
        expect(TIER2_AGENTS.has('openclaw')).toBe(true);
        expect(TIER2_AGENTS.has('claude')).toBe(false);
        expect(TIER2_AGENTS.has('pi')).toBe(false);
    });

    test('DISPLAY_ORDER includes all seven bundled agents', () => {
        expect(DISPLAY_ORDER).toHaveLength(7);
        expect(new Set(DISPLAY_ORDER).size).toBe(7);
        for (const name of DISPLAY_ORDER) {
            expect(isAgentName(name)).toBe(true);
        }
    });

    test('TIER1_PRIORITY contains only tier-1 agents in priority order', () => {
        expect(TIER1_PRIORITY).toHaveLength(5);
        for (const name of TIER1_PRIORITY) {
            expect(getAgentShim(name).tier).toBe(1);
        }
    });
});
