export function nowMs(): number {
    return Date.now();
}

export function toMs(input: Date | number | string | null | undefined): number | null {
    if (input === null || input === undefined) return null;
    if (input instanceof Date) return input.getTime();
    if (typeof input === 'string') {
        const parsed = new Date(input).getTime();
        return Number.isNaN(parsed) ? null : parsed;
    }
    // Reject NaN/±Infinity rather than passing them through as a "valid" timestamp.
    return Number.isFinite(input) ? Math.floor(input) : null;
}

export function fromMs(ms: number | null | undefined): Date | null {
    if (ms === null || ms === undefined || Number.isNaN(ms)) return null;
    return new Date(ms);
}
