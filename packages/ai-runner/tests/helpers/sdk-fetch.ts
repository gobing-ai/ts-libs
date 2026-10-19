/**
 * A stream-backed JSON `Response` for fake `fetch` seams.
 *
 * SDK 0.7.0 buffers every attempt through `response.clone()`'s reader, and on Bun 1.4.3 that leaves
 * a string / `Response.json()` body disturbed ("Body already used"). A real fetch response is
 * stream-backed, so the fixtures are too. Tests are exempt from the platform-API boundary rule.
 */
export function streamedJson(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    return new Response(
        new ReadableStream({
            start(controller) {
                controller.enqueue(bytes);
                controller.close();
            },
        }),
        { status, headers: { 'content-type': 'application/json', ...headers } },
    );
}
