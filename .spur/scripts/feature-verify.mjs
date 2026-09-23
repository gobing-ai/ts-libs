#!/usr/bin/env bun
// Feature-scoped verification driver (ADR-119 receipt contract).
//
// Project-owned port of the sp plugin's feature-verification-steps for repos
// that consume the sp plugin via installed skills (no plugins/sp/ source tree).
// The receipt seams are NOT exported by the spur CLI bundle, but they ship in
// the installed @gobing-ai/spur package under plugins/sp/lib/inline-run.generated.mjs;
// this driver resolves and imports that bundle, then:
//
//   resolves the feature-verification workflow definition (project layer wins),
//   records the RUNNING receipt (run-scoped + feature-latest copies),
//   registers the run-scoped receipt as a run artifact,
//   runs vars.verificationCmd via the safe launch splitter,
//   completes the receipt PASS/FAIL with the after-pass proof-input digest.
//
// A changed tree during the pass records FAIL (fail-closed).
//
// Run: bun .spur/scripts/feature-verify.mjs verify --feature-id <id> --run-id <id>
import { spawnSync } from 'node:child_process';
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function requireModule(entry) {
    const mod = await import(entry);
    const missing = [
        'startFeatureVerificationReceipt',
        'completeFeatureVerificationReceipt',
        'captureFeatureReceiptDigest',
        'resolveWorkflowDefinition',
        'splitLaunchCommand',
        'openInlineRunProjectDb',
        'ArtifactDao',
    ].filter((k) => typeof mod[k] !== 'function');
    if (missing.length > 0) {
        throw new Error(
            `module ${entry} is missing feature-verification seams (${missing.join(', ')}) \u2014 reinstall/upgrade @gobing-ai/spur`,
        );
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

function assertSafeId(kind, id) {
    if (!SAFE_ID_RE.test(id) || id.includes('..')) {
        throw new Error(`refusing unsafe ${kind}: ${id}`);
    }
}

function findFeatureFile(featureDir, featureId) {
    if (!existsSync(featureDir)) return;
    const name = readdirSync(featureDir).find((n) => n.startsWith(`${featureId}_`) && n.endsWith('.md'));
    return name === undefined ? undefined : join(featureDir, name);
}

const nodeFsShim = {
    ensureDir: (dir) => {
        mkdirSync(dir, { recursive: true });
    },
    writeFile: (path, body) => {
        writeFileSync(path, body);
    },
    rename: (src, dest) => {
        renameSync(src, dest);
    },
    readFile: (path) => {
        return readFileSync(path, 'utf8');
    },
};

async function verify(featureId, runId, spurModule) {
    assertSafeId('feature id', featureId);
    assertSafeId('run id', runId);
    const cwd = process.cwd();
    const mod = await loadSeams(spurModule);
    const runDir = join(cwd, '.spur', 'run');
    mkdirSync(runDir, { recursive: true });
    const selected = await mod.resolveWorkflowDefinition(cwd, 'feature-verification');
    const vars = selected.workflow.vars;
    const configuredCmd =
        typeof vars?.verificationCmd === 'string' && vars.verificationCmd.length > 0
            ? vars.verificationCmd
            : 'bun run spur-check-feature';
    const featureFile = findFeatureFile(join(cwd, 'docs', 'features'), featureId);
    if (featureFile === undefined) {
        throw new Error(`feature ${featureId} not found under ${join(cwd, 'docs', 'features')}`);
    }
    const featureContent = readFileSync(featureFile, 'utf8');
    const learningsPath = join(cwd, '.spur', 'context', 'learnings.md');
    const learningsContent = existsSync(learningsPath) ? readFileSync(learningsPath, 'utf8') : undefined;
    const beforeDigest = await mod.captureFeatureReceiptDigest(cwd, featureContent, learningsContent);
    const receipt = await mod.startFeatureVerificationReceipt(nodeFsShim, runDir, {
        featureId,
        runId,
        workdir: cwd,
        verifier: {
            name: 'feature-verification',
            sourcePath: selected.path,
            layer: selected.layer,
            definitionDigest: selected.digest,
        },
        verificationCmd: configuredCmd,
        inputDigest: beforeDigest,
    });
    const db = await mod.openInlineRunProjectDb(cwd);
    try {
        await new mod.ArtifactDao(db.adapter).record({
            runId,
            path: join(runDir, `${runId}-feature-verification.json`),
            kind: 'feature-verification',
        });
    } finally {
        db.close();
    }
    const logPath = join(runDir, `${runId}-feature-verification.log`);
    const launch = mod.splitLaunchCommand(configuredCmd, 'feature-verification verificationCmd');
    if ('error' in launch) {
        await mod.completeFeatureVerificationReceipt(nodeFsShim, runDir, receipt, {
            status: 'FAIL',
            inputDigest: beforeDigest,
        });
        console.log(`feature-verify: ${featureId} verification FAIL (${launch.error})`);
        return;
    }
    const logFd = openSync(logPath, 'a');
    try {
        const result = spawnSync(launch.command, launch.leadingArgs, {
            cwd,
            stdio: ['ignore', logFd, logFd],
            timeout: 14400000,
        });
        const exit = result.status ?? 1;
        const afterDigest = await mod.captureFeatureReceiptDigest(cwd, featureContent, learningsContent);
        const status = exit === 0 && afterDigest === beforeDigest ? 'PASS' : 'FAIL';
        await mod.completeFeatureVerificationReceipt(nodeFsShim, runDir, receipt, { status, inputDigest: afterDigest });
        console.log(`feature-verify: ${featureId} verification ${status} (run ${runId}, log ${logPath})`);
    } finally {
        closeSync(logFd);
    }
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
