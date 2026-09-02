/**
 * Internal cron expression grammar + matching (task 0734).
 *
 * This module is deliberately NOT exported from package.json — it is a shared
 * internal seam between `application-node.ts` (SchedulerJobConfig validation)
 * and `scheduler/node.ts` (adapter matching), so both consume the same grammar.
 * The public surface remains `NodeSchedulerAdapter` and `SchedulerJobConfig`.
 *
 * Supported grammar (five fields, whitespace-separated):
 *   minute       0-59
 *   hour         0-23
 *   day-of-month 1-31
 *   month        1-12
 *   day-of-week  0-7  (0 and 7 are both Sunday)
 *
 * Each field accepts a wildcard, a step-N wildcard form, a comma-separated list
 * of numbers or inclusive non-wrapping ranges, or a single number. Names/macros
 * (`MON`, `JAN`, `@daily`) and operators (`?`, `L`, `W`, `#`) are rejected.
 *
 * Matching uses local wall-clock fields (ADR / task 0734 R2): the fall-back hour
 * can fire twice at two distinct instants; a nonexistent spring-forward minute
 * never fires. No per-job timezone.
 */

/** A single cron field: either a wildcard (whole range) or an explicit value set. */
export interface CronFieldSpec {
    /** True when the whole field is `*` (matches every value in its range). */
    readonly wildcard: boolean;
    /** Allowed values when restricted. Day-of-week 7 is normalized into 0. */
    readonly values: ReadonlySet<number>;
}

/** A parsed five-field cron expression. */
export interface CronExpression {
    readonly minute: CronFieldSpec;
    readonly hour: CronFieldSpec;
    readonly dayOfMonth: CronFieldSpec;
    readonly month: CronFieldSpec;
    readonly dayOfWeek: CronFieldSpec;
    /** The original expression, for error messages and metrics. */
    readonly source: string;
}

/** Upper bound on the forward minute scan (8 calendar years, upper-capped at 366 days). */
const MAX_SCAN_MINUTES = 8 * 366 * 24 * 60;

const DAYS_OF_WEEK = 7; // 0-7 accepted on input, 7 aliases to 0

/**
 * Parse a single cron field into its wildcard/values spec.
 *
 * Throws `RangeError` for anything outside the supported grammar: names/macros,
 * operators, zero steps, empty list members, descending ranges, non-integer
 * values, or out-of-range values. Nothing silently falls back (task 0060 F7).
 */
function parseField(raw: string, min: number, max: number): CronFieldSpec {
    const trimmed = raw.trim();
    if (trimmed === '*') {
        return { wildcard: true, values: new Set<number>() };
    }

    // Names ('MON', 'JAN'), macros ('@daily'), and '?' are unsupported operators.
    if (/^[A-Za-z@?]/.test(trimmed)) {
        throw new RangeError(`unsupported cron field "${raw}": names/macros are not supported`);
    }

    // Whole-field step form: */N
    const stepMatch = trimmed.match(/^\*\/(\d+)$/);
    if (stepMatch) {
        const step = Number(stepMatch[1]);
        if (step <= 0) {
            throw new RangeError(`unsupported cron field "${raw}": step must be a positive integer`);
        }
        const values = new Set<number>();
        for (let v = min; v <= max; v += step) {
            values.add(v);
        }
        return { wildcard: false, values };
    }

    // Comma-separated list of numbers or inclusive non-wrapping ranges.
    const members = trimmed.split(',');
    if (members.some((m) => m.trim() === '')) {
        throw new RangeError(`unsupported cron field "${raw}": empty list member`);
    }

    const values = new Set<number>();
    for (const rawMember of members) {
        const member = rawMember.trim();
        if (member.includes('-')) {
            const rangeParts = member.split('-');
            if (rangeParts.length !== 2 || rangeParts.some((p) => p === '' || !/^\d+$/.test(p))) {
                throw new RangeError(`unsupported cron field "${raw}": invalid range "${rawMember}"`);
            }
            const lo = Number(rangeParts[0]);
            const hi = Number(rangeParts[1]);
            if (lo > hi) {
                throw new RangeError(`unsupported cron field "${raw}": descending range "${rawMember}"`);
            }
            if (lo < min || hi > max) {
                throw new RangeError(`cron field "${raw}" value out of range [${min}-${max}] in range "${rawMember}"`);
            }
            for (let v = lo; v <= hi; v++) {
                values.add(v);
            }
        } else {
            if (!/^\d+$/.test(member)) {
                throw new RangeError(`unsupported cron field "${raw}": invalid value "${rawMember}"`);
            }
            const v = Number(member);
            if (v < min || v > max) {
                throw new RangeError(`cron field "${raw}" value out of range [${min}-${max}]: ${rawMember}`);
            }
            values.add(v);
        }
    }

    return { wildcard: false, values };
}

/**
 * Parse a five-field cron expression into its spec.
 *
 * Throws `RangeError` on a wrong field count, any unsupported field grammar, or
 * out-of-range values. Day-of-week `7` normalizes to `0` (Sunday).
 */
export function parseCronExpression(source: string): CronExpression {
    const trimmed = source.trim();
    const parts = trimmed.split(/\s+/);
    if (parts.length !== 5) {
        throw new RangeError(`unsupported cron expression "${source}": expected exactly 5 fields, got ${parts.length}`);
    }

    const [rawMinute, rawHour, rawDom, rawMonth, rawDow] = parts as [string, string, string, string, string];

    const minute = parseField(rawMinute, 0, 59);
    const hour = parseField(rawHour, 0, 23);
    const dayOfMonth = parseField(rawDom, 1, 31);
    const month = parseField(rawMonth, 1, 12);
    let dayOfWeek = parseField(rawDow, 0, DAYS_OF_WEEK);

    // Standard cron: 7 is an alias for 0 (Sunday).
    if (!dayOfWeek.wildcard && dayOfWeek.values.has(DAYS_OF_WEEK)) {
        const values = new Set(dayOfWeek.values);
        values.delete(DAYS_OF_WEEK);
        values.add(0);
        dayOfWeek = { wildcard: false, values };
    }

    return { minute, hour, dayOfMonth, month, dayOfWeek, source: trimmed };
}

/**
 * Whether the instant matches the expression (local wall-clock fields).
 *
 * Day semantics follow standard cron: when both day fields are wildcards both
 * pass; when one is a wildcard the restricted field must match; when both are
 * restricted, either may match (OR).
 */
export function matchesCron(date: Date, expr: CronExpression): boolean {
    const minute = date.getMinutes();
    if (!expr.minute.wildcard && !expr.minute.values.has(minute)) return false;
    const hour = date.getHours();
    if (!expr.hour.wildcard && !expr.hour.values.has(hour)) return false;
    const month = date.getMonth() + 1;
    if (!expr.month.wildcard && !expr.month.values.has(month)) return false;

    const domWild = expr.dayOfMonth.wildcard;
    const dowWild = expr.dayOfWeek.wildcard;
    if (domWild && dowWild) return true;
    const domMatch = domWild || expr.dayOfMonth.values.has(date.getDate());
    const dowMatch = dowWild || expr.dayOfWeek.values.has(date.getDay());
    if (domWild) return dowMatch;
    if (dowWild) return domMatch;
    return domMatch || dowMatch;
}

/**
 * Compute the next matching minute strictly after `nowMs`, in local time.
 *
 * Starts at the next epoch-minute boundary and scans forward in one-minute
 * steps (fixed epoch increments, local wall-clock fields read per instant), so
 * DST fall-back selects both distinct instants and spring-forward skips
 * nonexistent minutes. Bounded to eight calendar years so an unsatisfiable
 * expression fails here (at registration) rather than silently never firing.
 *
 * # ponytail: O(minutes-to-next) forward scan, fine for small job counts; a
 * field-jumping search would matter only if startup cost with hundreds of jobs
 * ever shows up in measurements.
 */
export function nextCronTime(expr: CronExpression, nowMs: number): Date {
    // Next epoch-minute boundary strictly after now (never the current minute).
    let candidate = Math.floor(nowMs / 60_000) * 60_000 + 60_000;
    const limit = candidate + MAX_SCAN_MINUTES * 60_000;
    while (candidate < limit) {
        const instant = new Date(candidate);
        if (matchesCron(instant, expr)) {
            return instant;
        }
        candidate += 60_000;
    }
    throw new RangeError(`unsupported cron expression "${expr.source}": no matching time within 8 years`);
}
