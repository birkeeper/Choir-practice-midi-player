// Minimal test framework — no dependencies

export function assert(condition, message) {
    if (!condition) throw new Error(message ?? 'Assertion failed');
}

export function assertEquals(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(
            (message ? message + ': ' : '') +
            `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
        );
    }
}

export function withTimeout(promise, ms, message) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(message ?? `Timed out after ${ms}ms`)), ms)
        )
    ]);
}

// Drain a ReadableStream and return an array of Uint8Array chunks.
export async function readStream(stream, timeoutMs = 5000) {
    const reader = stream.getReader();
    const chunks = [];
    try {
        while (true) {
            const { done, value } = await withTimeout(reader.read(), timeoutMs, 'readStream timed out');
            if (done) break;
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    return chunks;
}

// Total byte count across an array of Uint8Array chunks.
export function totalBytes(chunks) {
    return chunks.reduce((n, c) => n + c.length, 0);
}

export class Suite {
    constructor(name) {
        this.name = name;
        this.tests = [];
    }
    test(name, fn) {
        this.tests.push({ name, fn });
        return this;
    }
}
