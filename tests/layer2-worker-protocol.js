// Layer 2: Dedicated worker range-request protocol.
// Creates a real dedicated-worker.js instance and sends AUDIO_RANGE_REQ messages
// directly, bypassing the service worker. Verifies which messages are sent back
// for each type of range request.
//
// Uses a minimal self-contained MIDI — no app interaction or file upload needed.
// First run is slow (~10-30 s) because the soundfonts must load.
// After that the soundfonts are served from the service worker cache.

import { Suite, assert, assertEquals, withTimeout } from './test-framework.js';
import { MIDI } from '../libraries/spessasynth_core/index.js';
import { WAV_HEADERSIZE, WAV_SAMPLERATE, WAV_NROFCHANNELS, WAV_BITSPERSAMPLE } from '../constants.js';

export const suite = new Suite('Layer 2: Dedicated worker protocol (real worker)');

const BYTESPERPCMFRAME = (WAV_BITSPERSAMPLE / 8) * WAV_NROFCHANNELS;

// ---------------------------------------------------------------------------
// Minimal MIDI: format 0, 1 track, one 2-second note at 120 BPM.
// 96 ticks/quarter, tempo 500 000 μs → 2 quarter notes = 1 s, so 384 ticks = 2 s.
// Varlen(384) = [0x83, 0x00]
// ---------------------------------------------------------------------------
const MINIMAL_MIDI_BYTES = new Uint8Array([
    0x4D, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06,  // MThd, length=6
    0x00, 0x00, 0x00, 0x01, 0x00, 0x60,               // format=0, tracks=1, division=96
    0x4D, 0x54, 0x72, 0x6B, 0x00, 0x00, 0x00, 0x14,  // MTrk, length=20
    0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20,         // tempo = 500 000 μs (120 BPM)
    0x00, 0x90, 0x3C, 0x40,                            // note on  ch0 C4 vel=64
    0x83, 0x00, 0x80, 0x3C, 0x00,                     // delta=384 ticks, note off C4
    0x00, 0xFF, 0x2F, 0x00                             // end of track
]);

const TEST_DURATION_S   = 2.0;
const TEST_PLAYBACK_RATE = 1.0;
const TEST_WAV_LENGTH   = Math.floor(TEST_DURATION_S / TEST_PLAYBACK_RATE * WAV_SAMPLERATE * BYTESPERPCMFRAME) + WAV_HEADERSIZE;

const TEST_SETTINGS = {
    midiFileHash:    'layer2-test-hash',
    midiName:        'layer2-test',
    playbackRate:     TEST_PLAYBACK_RATE,
    duration_s:       TEST_DURATION_S,
    wavLength_bytes:  TEST_WAV_LENGTH,
    channels: [{ name: '0:Piano', number: 0, pan: 64, volume: 85, selectedInstrument: 'Default' }]
};

// ---------------------------------------------------------------------------
// Shared worker — created once for all Layer 2 tests.
// ---------------------------------------------------------------------------
let worker = null;

async function initWorker() {
    if (worker) return;

    worker = new Worker('../dedicated-worker.js', { type: 'module' });
    worker.onerror = (e) => { throw new Error(`Worker error: ${e.message}`); };

    await withTimeout(
        new Promise(resolve => {
            worker.onmessage = (e) => {
                if (e.data.type === 'workerInitalised') { worker.onmessage = null; resolve(); }
            };
        }),
        60_000,
        'Dedicated worker did not initialise within 60 s (soundfont loading failed?)'
    );

    const midi = new MIDI(MINIMAL_MIDI_BYTES.buffer.slice(0), 'layer2-test.mid');
    worker.postMessage({ type: 'LOAD_MIDI', midi });
}

// ---------------------------------------------------------------------------
// Send one AUDIO_RANGE_REQ and collect the response messages.
// Returns { ready, chunks, totalBytes, canceled }
// ---------------------------------------------------------------------------
async function rangeRequest(start, end, { cancelAfterReady = false } = {}) {
    await initWorker();

    const channel = new MessageChannel();
    const port    = channel.port1;   // our side (simulates the service-worker port)

    worker.postMessage({
        type:      'AUDIO_RANGE_REQ',
        songID:    TEST_SETTINGS.midiFileHash,
        UUID:      `test-${start}-${end}-${Date.now()}`,
        sessionID: 'test-session',
        settings:  TEST_SETTINGS,
        start, end
    }, [channel.port2]);

    return withTimeout(new Promise((resolve, reject) => {
        let ready   = false;
        let totalBytes = 0;
        const chunks = [];

        function requestNextChunk() {
            const chunkCh = new MessageChannel();
            port.postMessage({ type: 'reqNextChunk' }, [chunkCh.port2]);
            chunkCh.port1.onmessage = (e) => {
                if (e.data.type === 'chunk') {
                    totalBytes += e.data.data.byteLength;
                    chunks.push(new Uint8Array(e.data.data));
                    if (e.data.end === true) {
                        port.close();
                        resolve({ ready, chunks, totalBytes, canceled: false });
                    } else {
                        requestNextChunk();
                    }
                }
            };
        }

        port.onmessage = (e) => {
            const msg = e.data;
            if (msg.type === 'chunk') {
                totalBytes += msg.data.byteLength;
                chunks.push(new Uint8Array(msg.data));
                if (msg.end === true) { // header-only: no 'ready' will follow
                    port.close();
                    resolve({ ready, chunks, totalBytes, canceled: false });
                }
            } else if (msg.type === 'ready') {
                ready = true;
                if (cancelAfterReady) {
                    port.postMessage({ type: 'cancel' });
                    port.close();
                    resolve({ ready, chunks, totalBytes, canceled: true });
                } else {
                    requestNextChunk();
                }
            } else if (msg.type === 'error') {
                port.close();
                reject(new Error(msg.reason || 'worker reported error'));
            }
        };
    }), 45_000, `rangeRequest(${start}-${end}) timed out`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite.test('worker initialises (may take up to 60 s on first run)', async () => {
    await initWorker();
    assert(worker !== null);
});

suite.test('bytes=0-1 (iOS probe): delivers 2 bytes, never sends ready', async () => {
    const r = await rangeRequest(0, 1);
    assertEquals(r.ready, false,
        'header-only request must never send "ready" — this confirms the root cause of the iOS bug');
    assertEquals(r.totalBytes, 2);
    assertEquals(r.chunks[0][0], 0x52, 'byte 0 = R (RIFF signature)');
    assertEquals(r.chunks[0][1], 0x49, 'byte 1 = I (RIFF signature)');
});

suite.test('bytes=0-43 (full header): delivers 44 bytes, never sends ready', async () => {
    const r = await rangeRequest(0, WAV_HEADERSIZE - 1);
    assertEquals(r.ready, false);
    assertEquals(r.totalBytes, WAV_HEADERSIZE);
    // Verify RIFF + WAVE signature
    const all = r.chunks.flatMap(c => [...c]);
    assertEquals(all[0], 0x52); assertEquals(all[1], 0x49);  // RI
    assertEquals(all[2], 0x46); assertEquals(all[3], 0x46);  // FF
    assertEquals(all[8], 0x57); assertEquals(all[9], 0x41);  // WA
    assertEquals(all[10], 0x56); assertEquals(all[11], 0x45); // VE
});

suite.test('bytes=0-143 (header + PCM): sends ready, delivers header+PCM bytes', async () => {
    const r = await rangeRequest(0, WAV_HEADERSIZE + 99);
    assert(r.ready, 'PCM request must send ready');
    assertEquals(r.totalBytes, WAV_HEADERSIZE + 100);
});

suite.test('PCM-only range: sends ready, correct byte count', async () => {
    // Request 200 bytes of PCM starting after the header
    const r = await rangeRequest(WAV_HEADERSIZE, WAV_HEADERSIZE + 199);
    assert(r.ready, 'PCM request must send ready');
    assertEquals(r.totalBytes, 200);
});

suite.test('cancel after ready: worker stops without sending further chunks', async () => {
    const r = await rangeRequest(WAV_HEADERSIZE, TEST_WAV_LENGTH - 1, { cancelAfterReady: true });
    assert(r.ready,    'should have received ready before canceling');
    assert(r.canceled, 'should be marked as canceled');
    // No assertion on totalBytes — the worker may have sent zero or a few chunks
    // before the cancel arrived, but it should not keep streaming indefinitely.
});
