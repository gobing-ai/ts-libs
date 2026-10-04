import { describe, expect, test } from 'bun:test';
import { createDbAdapter } from '@gobing-ai/ts-db';
import { EventBus } from '@gobing-ai/ts-infra';
import type { WorkflowEngineEvents } from '../src/events';
import { createDefaultWorkflowEngineHost } from '../src/host';
import { DbWorkflowPersistenceAdapter } from '../src/persistence';
import { WorkflowService } from '../src/service';

describe('E2E multi-channel publish integration fixture (task 0098)', () => {
    test('concurrently executes independent publish channels (podcast, xhs, wechat)', async () => {
        const events = new EventBus<WorkflowEngineEvents>();
        const branchEvents: string[] = [];

        events.on('workflow.branch.started', (data) => {
            branchEvents.push(`started:${data.branchId}:${data.node}`);
        });
        events.on('workflow.branch.done', (data) => {
            branchEvents.push(`done:${data.branchId}:${data.ok}`);
        });

        const host = createDefaultWorkflowEngineHost()
            .registerAction({
                kind: 'prepare-content-action',
                async execute() {
                    return {
                        ok: true,
                        setVars: {
                            article_title: 'AI Engineering Weekly',
                            audio_path: '/tmp/podcast.mp3',
                        },
                    };
                },
            })
            .registerAction({
                kind: 'podcast-publish-action',
                async execute(_options, ctx) {
                    expect(ctx.vars.article_title).toBe('AI Engineering Weekly');
                    await new Promise((r) => setTimeout(r, 40));
                    return { ok: true, setVars: { podcast_url: 'https://podcast.example.com/ep1' } };
                },
            })
            .registerAction({
                kind: 'xhs-publish-action',
                async execute(_options, ctx) {
                    expect(ctx.vars.article_title).toBe('AI Engineering Weekly');
                    await new Promise((r) => setTimeout(r, 45));
                    return { ok: true, setVars: { xhs_post_id: 'xhs-12345' } };
                },
            })
            .registerAction({
                kind: 'wechat-publish-action',
                async execute(_options, ctx) {
                    expect(ctx.vars.article_title).toBe('AI Engineering Weekly');
                    await new Promise((r) => setTimeout(r, 35));
                    return { ok: true, setVars: { wechat_article_id: 'wx-67890' } };
                },
            })
            .registerAction({
                kind: 'aggregate-summary-action',
                async execute(_options, ctx) {
                    return {
                        ok: true,
                        data: {
                            podcast: ctx.vars.podcast_url,
                            xhs: ctx.vars.xhs_post_id,
                            wechat: ctx.vars.wechat_article_id,
                        },
                    };
                },
            });

        const db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        const persistence = new DbWorkflowPersistenceAdapter(db);
        const service = new WorkflowService(host, persistence);

        const startTime = Date.now();
        const result = await service.run(
            {
                kind: 'transition-flow',
                name: 'multi-channel-publish',
                initialNode: 'prepare',
                terminalNodes: ['finished'],
                nodes: [
                    { id: 'prepare', action: { kind: 'prepare-content-action' } },
                    {
                        id: 'fanout-publish',
                        type: 'parallel',
                        branches: [
                            { id: 'branch-podcast', startNode: 'pub-podcast' },
                            { id: 'branch-xhs', startNode: 'pub-xhs' },
                            { id: 'branch-wechat', startNode: 'pub-wechat' },
                        ],
                        join: 'join-publish',
                        concurrencyLimit: 4,
                    },
                    { id: 'pub-podcast', action: { kind: 'podcast-publish-action' } },
                    { id: 'pub-xhs', action: { kind: 'xhs-publish-action' } },
                    { id: 'pub-wechat', action: { kind: 'wechat-publish-action' } },
                    { id: 'join-publish', action: { kind: 'aggregate-summary-action' } },
                    { id: 'finished' },
                ],
                edges: [
                    { from: 'prepare', to: 'fanout-publish' },
                    { from: 'fanout-publish', to: 'pub-podcast' },
                    { from: 'fanout-publish', to: 'pub-xhs' },
                    { from: 'fanout-publish', to: 'pub-wechat' },
                    { from: 'pub-podcast', to: 'join-publish' },
                    { from: 'pub-xhs', to: 'join-publish' },
                    { from: 'pub-wechat', to: 'join-publish' },
                    { from: 'join-publish', to: 'finished' },
                ],
            },
            { events },
        );

        const duration = Date.now() - startTime;
        expect(result.status).toBe('done');
        expect(result.finalState).toBe('finished');

        // Wall-clock duration must be strictly less than sequential sum (40 + 45 + 35 = 120ms)
        expect(duration).toBeLessThan(90);

        // Verify persisted branches in DB
        const branches = await persistence.listRunBranches(result.runId, 'fanout-publish');
        expect(branches.length).toBe(3);
        expect(branches.every((b) => b.status === 'done')).toBe(true);

        // Verify branch lifecycle events were emitted
        expect(branchEvents).toContain('started:branch-podcast:pub-podcast');
        expect(branchEvents).toContain('started:branch-xhs:pub-xhs');
        expect(branchEvents).toContain('started:branch-wechat:pub-wechat');
        expect(branchEvents).toContain('done:branch-podcast:true');
        expect(branchEvents).toContain('done:branch-xhs:true');
        expect(branchEvents).toContain('done:branch-wechat:true');
    });
});
