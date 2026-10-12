#!/usr/bin/env bun
// Project argv adapter for Spur's feature verification and receipt operation.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

async function requireModule(entry) {
    const mod = await import(entry);
    if (typeof mod.runFeatureVerification !== 'function') {
        throw new Error(`module ${entry} is missing runFeatureVerification — reinstall/upgrade @gobing-ai/spur`);
    }
    return mod;
}

async function loadSeams(spurModule) {
    if (spurModule !== '' && existsSync(spurModule)) {
        return requireModule(resolve(spurModule));
    }
    // Resolve the installed spur CLI: `command -v spur` → realpath → walk up to
    // the package dir that carries the seams bundle.
    const probe = spawnSync('sh', ['-c', 'command -v spur'], { encoding: 'utf8' });
    const bin = (probe.stdout ?? '').trim().split(/\s+/)[0] ?? '';
    if (bin !== '' && existsSync(bin)) {
        let dir = dirname(realpathSync(bin));
        for (let i = 0; i < 4; i++) {
            const bundle = join(dir, 'plugins', 'sp', 'lib', 'inline-run.generated.mjs');
            if (existsSync(bundle)) return requireModule(bundle);
            const parent = dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    throw new Error(
        'cannot locate the @gobing-ai/spur seams bundle (plugins/sp/lib/inline-run.generated.mjs) \u2014 pass --spur-module <path>',
    );
}

async function verify(featureId, runId, spurModule) {
    const mod = await loadSeams(spurModule);
    const result = await mod.runFeatureVerification({ workdir: process.cwd(), featureId, runId });
    console.log(`feature-verify: ${featureId} ${result.message}`);
}

function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    const flag = (name) => {
        const i = args.indexOf(name);
        return i >= 0 && i + 1 < args.length ? (args[i + 1] ?? '') : '';
    };
    if (command !== 'verify') {
        console.error('Usage: feature-verify.mjs verify --feature-id <id> --run-id <id> [--spur-module <path>]');
        process.exit(2);
    }
    verify(
        flag('--feature-id') || process.env.featureId || '',
        flag('--run-id') || process.env.__runId || '',
        flag('--spur-module') || '',
    )
        .then(() => process.exit(0))
        .catch((err) => {
            console.error(`feature-verify: ${String(err)}`);
            process.exit(1);
        });
}

main();
