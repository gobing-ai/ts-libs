import { NodeProcessExecutor } from '@gobing-ai/ts-runtime';
import { HistoryImportError } from './errors';

/**
 * Decompress one checksummed Zstandard session log through the system `zstd`
 * CLI (task 0067 R5 — sanctioned process seam, ADR-014). A missing executable
 * or a decompression failure raises an actionable HistoryImportError naming
 * zstd and the file — never a bare spawn failure.
 *
 * ponytail: buffered decompression; swap to `ProcessExecutor.runStreaming`
 * (`zstd -dc <file>` stdout piping) if live sessions regularly exceed ~100 MB
 * decompressed.
 */
export async function zstdDecompress(file: string, env?: Record<string, string>): Promise<string> {
    const result = await new NodeProcessExecutor().run({
        command: 'zstd',
        args: ['-dc', file],
        env,
        timeout: 120_000,
        label: 'llm-jsonl-importer:zstd-decompression',
    });
    // execa resolves an unresolvable executable with a null exit code (no child
    // ran) — that is the "no zstd on PATH" case; a numeric non-zero code is a
    // real zstd failure (corrupt frame, missing file, bad checksum).
    if (result.exitCode === null || result.exitCode !== 0) {
        const reason =
            result.exitCode === null
                ? 'the zstd executable is required on PATH to import *.jsonl.zstd session logs'
                : `zstd (exit ${result.exitCode}) reported: ${result.stderr.trim().slice(0, 500) || result.stdout.trim().slice(0, 200)}`;
        throw new HistoryImportError(`zstd decompression failed for ${file}: ${reason}`, { file });
    }
    return result.stdout;
}
