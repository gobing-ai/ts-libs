import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const ext = '.js';

for (const name of ['utils', 'runtime']) {
    const entry = `./packages/${name}/dist/index${ext}`;
    smokeImport('node', ['-e', `const p = ${JSON.stringify(entry)}; import(p)`], `package "${name}" with Node`);
}

for (const name of ['db', 'infra']) {
    const entry = `./packages/${name}/dist/index${ext}`;
    smokeImport('bun', ['-e', `const p = ${JSON.stringify(entry)}; await import(p)`], `package "${name}" with Bun`);
}

function smokeImport(command: string, args: string[], label: string): void {
    const result = spawnSync(command, args, {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: 'pipe',
    });

    if (result.status !== 0) {
        const stderr = result.stderr.trim();
        const stdout = result.stdout.trim();
        throw new Error(`Failed to import built ${label}: ${stderr || stdout || `exit ${result.status}`}`);
    }
}
