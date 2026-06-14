// Layer 1: Pure math — WAV constants and byte-range calculations.
// No workers, no network. Always fast.

import { Suite, assert, assertEquals } from './test-framework.js';
import {
    WAV_HEADERSIZE, WAV_SAMPLERATE, WAV_NROFCHANNELS, WAV_BITSPERSAMPLE
} from '../constants.js';

export const suite = new Suite('Layer 1: WAV constants & math');

const BYTESPERPCMFRAME = (WAV_BITSPERSAMPLE / 8) * WAV_NROFCHANNELS;

suite.test('WAV_HEADERSIZE is 44', () => {
    assertEquals(WAV_HEADERSIZE, 44);
});

suite.test('bytes=0-1 is classified as header-only (end < WAV_HEADERSIZE)', () => {
    assert(1 < WAV_HEADERSIZE);  // iOS probe: bytes=0-1
});

suite.test('bytes=0-43 is header-only, bytes=0-44 is not', () => {
    assert(43 < WAV_HEADERSIZE,  'end=43 should be header-only');
    assert(!(44 < WAV_HEADERSIZE), 'end=44 spans into PCM — not header-only');
});

suite.test('wavLength_bytes formula produces an integer larger than WAV_HEADERSIZE', () => {
    const duration = 60;     // seconds
    const playbackRate = 1.0;
    const result = Math.floor(duration / playbackRate * WAV_SAMPLERATE * (WAV_BITSPERSAMPLE / 8) * WAV_NROFCHANNELS) + WAV_HEADERSIZE;
    assert(Number.isInteger(result), 'wavLength_bytes must be an integer');
    assert(result > WAV_HEADERSIZE,  'wavLength_bytes must exceed the header size');
});

suite.test('faster playbackRate produces a smaller WAV file', () => {
    const duration = 60;
    const bytes = (r) => Math.floor(duration / r * WAV_SAMPLERATE * (WAV_BITSPERSAMPLE / 8) * WAV_NROFCHANNELS) + WAV_HEADERSIZE;
    assert(bytes(0.5) > bytes(1.0), '0.5x rate > 1x rate');
    assert(bytes(1.0) > bytes(2.0), '1x rate > 2x rate');
});

suite.test('PCM frame size is 4 bytes (16-bit stereo)', () => {
    assertEquals(BYTESPERPCMFRAME, 4);
});

suite.test('dataStartAligned is always <= dataStart and divisible by frame size', () => {
    // Mirrors the alignment logic in dedicated-worker.js
    for (const byteOffset of [0, 1, 100, 1001, 28966912]) {
        const dataStart = Math.max(byteOffset, WAV_HEADERSIZE) - WAV_HEADERSIZE;
        const aligned   = Math.floor(dataStart / BYTESPERPCMFRAME) * BYTESPERPCMFRAME;
        assert(aligned <= dataStart,           `aligned (${aligned}) must be <= dataStart (${dataStart})`);
        assertEquals(aligned % BYTESPERPCMFRAME, 0, `aligned must be divisible by BYTESPERPCMFRAME`);
    }
});

suite.test('dataEndExclusiveAligned is always >= dataEndExclusive', () => {
    const dataLength_bytes = Math.floor(60 / 1.0 * WAV_SAMPLERATE * BYTESPERPCMFRAME);
    for (const end of [43, 44, 100, 1000, dataLength_bytes + WAV_HEADERSIZE - 1]) {
        const dataEndExclusive = Math.max(Math.min(end + 1 - WAV_HEADERSIZE, dataLength_bytes), 0);
        const aligned          = Math.ceil(dataEndExclusive / BYTESPERPCMFRAME) * BYTESPERPCMFRAME;
        assert(aligned >= dataEndExclusive, `alignedEnd (${aligned}) must be >= dataEndExclusive (${dataEndExclusive})`);
        assertEquals(aligned % BYTESPERPCMFRAME, 0, 'alignedEnd must be divisible by BYTESPERPCMFRAME');
    }
});
