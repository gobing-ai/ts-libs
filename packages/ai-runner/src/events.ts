import type { EventSeverity } from '@gobing-ai/ts-infra';
import type { ProcessEvents } from '@gobing-ai/ts-runtime';
import type { AgentRunCorrelation } from './ai-runner';

/** Typed event map for agent-runner observability. All events prefixed `agent.`. */
export type AgentEvents = {
    /** Emitted immediately before an agent CLI invocation starts. */
    'agent.invoke.start': (data: {
        agent: string;
        operation: string;
        label: string;
        correlation?: AgentRunCorrelation;
        severity: EventSeverity;
    }) => void;
    /** Emitted after an agent CLI invocation exits. */
    'agent.invoke.exit': (data: {
        agent: string;
        operation: string;
        label: string;
        exitCode: number | null;
        signal?: string;
        durationMs: number;
        correlation?: AgentRunCorrelation;
        severity: EventSeverity;
    }) => void;
    /** Emitted when a long-running team agent process starts. */
    'agent.started': (data: {
        agentId: string;
        agentType: string;
        pid: number | null;
        severity: EventSeverity;
    }) => void;
    /** Emitted when a long-running team agent process stops. */
    'agent.stopped': (data: { agentId: string; exitCode: number | null; severity: EventSeverity }) => void;
    /** Emitted when a message is sent to a team agent process. */
    'agent.message.sent': (data: { agentId: string; ok: boolean; severity: EventSeverity }) => void;
};

/** Event map for process-level observability emitted by AiRunner-owned executors. */
export type AiRunnerProcessEvents = ProcessEvents;
