/**
 * SQL sanitization for debug-mode DB statement capture.
 *
 * Strips parameter values, string literals, numeric literals, and
 * identifier-specific data from SQL text before it is attached to spans.
 */

/**
 * Redact string literals and numeric literals from SQL text.
 */
export function sanitizeSql(sql: string): string {
    let result = '';
    let i = 0;
    const len = sql.length;

    while (i < len) {
        const code = sql.charCodeAt(i);

        // Quote characters: ' (39) or " (34)
        if (code === 39 || code === 34) {
            const quote = code;
            i++;
            while (i < len) {
                if (sql.charCodeAt(i) === quote) {
                    if (sql.charCodeAt(i + 1) === quote) {
                        i += 2;
                        continue;
                    }
                    i++;
                    break;
                }
                i++;
            }
            result += '?';
            continue;
        }

        // Numeric literal
        if (code >= 48 && code <= 57) {
            const prev = result.length > 0 ? result.charCodeAt(result.length - 1) : 0;
            const isIdentifierContinuation =
                (prev >= 65 && prev <= 90) || (prev >= 97 && prev <= 122) || prev === 95 || (prev >= 48 && prev <= 57);

            if (!isIdentifierContinuation) {
                while (i < len) {
                    const c = sql.charCodeAt(i);
                    if (c < 48 || c > 57) break;
                    i++;
                }
                if (i < len && sql.charCodeAt(i) === 46 && i + 1 < len) {
                    const next = sql.charCodeAt(i + 1);
                    if (next >= 48 && next <= 57) {
                        i++;
                        while (i < len) {
                            const c = sql.charCodeAt(i);
                            if (c < 48 || c > 57) break;
                            i++;
                        }
                    }
                }
                result += '?';
                continue;
            }
        }

        result += sql[i] ?? '';
        i++;
    }

    return result;
}

/**
 * Extract the SQL operation keyword (SELECT, INSERT, UPDATE, DELETE, etc.)
 */
export function extractSqlOperation(sql: string): string | undefined {
    const match = sql.trim().match(/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA)\b/i);
    return match?.[1]?.toUpperCase();
}
