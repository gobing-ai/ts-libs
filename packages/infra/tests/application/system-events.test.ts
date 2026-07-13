import { describe, expect, test } from 'bun:test';
import { runApplication } from '../../src/application';
import type { FileObserverWriter } from '../../src/event-bus/file-observer';

function recordingWriter(recorded: string[]): FileObserverWriter {
    return {
        ensureDir() {
            // In-memory writer: no directory creation required.
        },
        appendFile(_path: string, content: string) {
            recorded.push(content);
        },
    };
}

describe('System Events — application file observer', () => {
    test('runApplication defaults attach the shared lifecycle bus to the JSONL writer', async () => {
        const recorded: string[] = [];
        const app = await runApplication({
            services: { fileObserverWriter: recordingWriter(recorded) },
            start() {},
        });

        await app.events.emit('api.request.error', {
            url: '/x',
            method: 'GET',
            error: 'boom',
        });

        expect(app.config.events.fileObserver).toBe(true);
        expect(app.config.events.filePath).toBe('logs/system-events.jsonl');
        expect(recorded.length).toBeGreaterThanOrEqual(1);
        const parsed = recorded.map((line) => JSON.parse(line)).find((row) => row.event === 'api.request.error');
        expect(parsed?.lifecycle).toBeDefined();
        await app.stop();
    });

    test('fileObserver false performs no JSONL writes', async () => {
        const recorded: string[] = [];
        const app = await runApplication({
            config: { events: { fileObserver: false } },
            services: { fileObserverWriter: recordingWriter(recorded) },
            start() {},
        });

        await app.events.emit('api.request.error', {
            url: '/y',
            method: 'POST',
            error: 'fail',
        });

        expect(app.config.events.fileObserver).toBe(false);
        expect(recorded).toEqual([]);
        await app.stop();
    });
});
