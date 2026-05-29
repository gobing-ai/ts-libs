import { describe, expect, test } from 'bun:test';
import { branchPushArgs, tagPushArgs } from '../lib/release';

describe('release command git push args', () => {
    test('branch push disables followTags even when user git config enables it', () => {
        expect(branchPushArgs('main')).toEqual([
            '-c',
            'push.followTags=false',
            'push',
            '--no-follow-tags',
            'origin',
            'main',
        ]);
    });

    test('tag push uses explicit source and destination refs one tag at a time', () => {
        expect(tagPushArgs('@gobing-ai/ts-utils-v0.1.6')).toEqual([
            '-c',
            'push.followTags=false',
            'push',
            'origin',
            'refs/tags/@gobing-ai/ts-utils-v0.1.6:refs/tags/@gobing-ai/ts-utils-v0.1.6',
        ]);
    });
});
