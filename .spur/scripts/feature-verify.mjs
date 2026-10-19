#!/usr/bin/env bun
// Project argv adapter for Spur's feature verification and receipt operation.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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

/** The gate the pass runs when the caller supplies no `--cmd` — the project's own feature gate. */
const DEFAULT_CMD = 'bun run spur-check-feature';

/**
 * Commands whose PASS covers the whole project gate. A receipt that ran one of these earned the
 * HIGH level; anything else (`--cmd` narrowed to a subset) proves less, whatever the exit code.
 */
const FULL_GATE_CMDS = new Set(['bun run spur-check-feature', 'bun run spur-check', 'spur self exec check-feature']);

/** Derive the receipt's confidence level from what the pass actually proved — never a self-assignment. */
function confidenceFor(status, cmd) {
    const command = String(cmd ?? '').trim();
    if (status !== 'PASS') return { level: 'LOW', basis: `receipt status ${String(status)} cannot certify a pass` };
    if (FULL_GATE_CMDS.has(command)) return { level: 'HIGH', basis: `full project gate: ${command}` };
    return { level: 'MEDIUM', basis: `narrowed command cannot prove more than its own checks: ${command}` };
}

/**
 * Stamp both receipt copies (feature-latest and run-scoped) with the confidence contract. The seam
 * writes the receipt; the level is the project's claim about what the pass proved, so it is added
 * here rather than asserted by the writer. Spur's receipt parser tolerates the extra fields.
 * A pass that wrote no receipt leaves nothing to stamp — the rule's cutover check reports that.
 */
function stampReceipts(evidenceDir, featureId, fallbackCmd) {
    const featureCopy = join(evidenceDir, `${featureId}-feature-verification.json`);
    if (!existsSync(featureCopy)) {
        console.error(`feature-verify: no receipt at ${featureCopy} — confidence level not recorded`);
        return;
    }
    const receipt = JSON.parse(readFileSync(featureCopy, 'utf8'));
    const { level, basis } = confidenceFor(receipt.status, receipt.verificationCmd ?? fallbackCmd);
    const copies = [featureCopy];
    if (typeof receipt.runId === 'string' && receipt.runId !== '') {
        copies.push(join(evidenceDir, `${receipt.runId}-feature-verification.json`));
    }
    for (const path of copies) {
        if (!existsSync(path)) continue;
        const current = JSON.parse(readFileSync(path, 'utf8'));
        current.confidenceContract = 1;
        current.confidence = level;
        current.confidenceBasis = basis;
        writeFileSync(path, `${JSON.stringify(current, null, 4)}\n`);
    }
    console.log(`feature-verify: confidence ${level} recorded in ${copies.join(', ')}`);
}

/** Run the pass through this install's `spur` CLI when the seams bundle cannot be located. */
function verifyViaCli(featureId, runId, cmd) {
    const args = ['feature', 'verify', featureId];
    if (cmd !== '') args.push('--cmd', cmd);
    if (runId !== '') args.push('--run-id', runId);
    const pass = spawnSync('spur', args, { stdio: 'inherit' });
    if (pass.error) throw pass.error;
    // Exit 1 means the pass could not run; stamping its RUNNING receipt would mask the failure.
    if (pass.status !== 0) throw new Error(`spur feature verify exited ${pass.status}`);
    return pass;
}

async function verify(featureId, runId, spurModule, cmd, overrideCmd) {
    const evidenceDir = join(process.cwd(), '.spur', 'memory', 'evidence');
    let mod;
    try {
        mod = await loadSeams(spurModule);
    } catch (err) {
        if (spurModule !== '') throw err; // an explicit module that cannot load is a caller error
        // Same rule as the seam path: only an explicit `--cmd` overrides the configured definition.
        verifyViaCli(featureId, runId, overrideCmd);
        stampReceipts(evidenceDir, featureId, cmd);
        return;
    }
    const result = await mod.runFeatureVerification({
        workdir: process.cwd(),
        featureId,
        runId,
        // Only an explicit `--cmd` overrides the seam: the definition already names the project
        // gate, and injecting a default here would change the call shape every existing caller sees.
        ...(overrideCmd !== '' ? { cmdOverride: overrideCmd } : {}),
    });
    console.log(`feature-verify: ${featureId} ${result.message}`);
    stampReceipts(evidenceDir, featureId, cmd);
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
        flag('--cmd') || DEFAULT_CMD,
        flag('--cmd'),
    )
        .then(() => process.exit(0))
        .catch((err) => {
            console.error(`feature-verify: ${String(err)}`);
            process.exit(1);
        });
}

main();
