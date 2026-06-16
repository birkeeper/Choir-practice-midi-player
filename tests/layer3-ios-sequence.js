// Layer 3: End-to-end iOS range-request sequence via the real service worker.
//
// Simulates the HTTP request sequence that iOS Safari issues when src is set
// on an <audio> element.  The sequence is run 3 times with a settings update
// between each run, to reproduce the "MEDIA_ERR_SRC_NOT_SUPPORTED after 3
// settings changes" regression.
//
// Request sequence per iteration:
//   Step 1 – bytes=0-1            → read to completion  (iOS header probe)
//   Step 2 – bytes=0-{total-1}   → issue, then cancel   (iOS duration probe)
//   Step 3 – bytes={tail}        → read to completion  (iOS tail metadata)
//   Step 4 – bytes=0-1445        → read to completion  (iOS initial buffer)
//   Step 5 – bytes={pos}-{end}   → read 2 s of audio, then cancel
//
// Requires:
//   - Service worker is registered and active.
//   - At least one song is stored in the SW cache (load a MIDI in the app first).
//
// Recommended: use a short MIDI (< 60 s) to keep synthesis time reasonable.

import { Suite, assert, assertEquals, withTimeout } from './test-framework.js';

export const suite = new Suite('Layer 3: iOS range sequence (full-stack regression)');

const WAV_HEADERSIZE    = 44;
const BYTESPERPCMFRAME  = 4;
const WAV_SAMPLERATE    = 44100;
const TAIL_BYTES        = 44658;   // iOS tail probe size
const PLAY_DURATION_S   = 2;     // seconds of audio to synthesise in step 5
const PLAY_RANGE_BYTES  = PLAY_DURATION_S * WAV_SAMPLERATE * BYTESPERPCMFRAME;
const CANCEL_DELAY_MS   = 500;   // ms before aborting the step-2 probe

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getSwRegistration() {
    const reg = await navigator.serviceWorker.getRegistration('./');
    if (!reg || !reg.active) throw new Error('Service worker not active');
    return reg;
}

// Ask the SW for all cached settings objects; return the first one.
async function getCachedSettingsLastOpenedSong() {
    const reg = await getSwRegistration();
    return new Promise((resolve, reject) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = (e) => {
            const historyList = e.data;
            if (!Array.isArray(historyList)) { 
                reject(new Error('No songs in SW cache — load a MIDI in the app first'));
            } else {
                historyList.sort((a,b) => { // sort list by date, last opened first
                    if (!Object.hasOwn(a, "lastOpened")) {return 1;}
                    if (!Object.hasOwn(b, "lastOpened")) {return -1;}
                    if (a.lastOpened > b.lastOpened) {return -1;}
                    else { return 1;}
                });
               resolve(e.data[0]);
            }
        };
        reg.active.postMessage({ type: 'all' }, [ch.port2]);
    });
}

// Store updated settings back into the SW cache.
async function storeSettings(key, settings) {
    const reg = await getSwRegistration();
    return new Promise(resolve => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => resolve();
        reg.active.postMessage({ type: 'storeSettings', key, settings }, [ch.port1]);
    });
}

// Fetch a Range request through the SW.
// Returns { status, contentRange, totalBytes, firstBytes }
async function fetchRange(hash, rangeHeader, cancelDelay_ms = undefined) {
    const uuid = crypto.randomUUID();
    const url  = `./generatedWav/${hash}_${uuid}.wav`;
    const resp = await fetch(url, { headers: { Range: rangeHeader } });
    const reader = resp.body.getReader();
    if (cancelDelay_ms !== undefined) {
        const timer = setTimeout(() => reader.cancel(), cancelDelay_ms);
    }

    let totalBytes = 0;
    let firstBytes = null;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.length;
            if (!firstBytes) firstBytes = value;
        }
    } catch (e) {
        // AbortError is expected when we intentionally cancel
        if (e.name !== 'AbortError') throw e;
    } finally {
        reader.releaseLock();
    }
    return { status: resp.status, contentRange: resp.headers.get('Content-Range'), totalBytes, firstBytes };
}


// Compute wav length in bytes from settings.
function wavLength(settings) {
    return Math.floor(settings.duration_s / settings.playbackRate * WAV_SAMPLERATE * BYTESPERPCMFRAME) + WAV_HEADERSIZE;
}

// ---------------------------------------------------------------------------
// The iOS request sequence for one settings iteration.
// ---------------------------------------------------------------------------
async function runIosSequence(settings, iterLabel) {
    const hash  = settings.midiFileHash;
    const total = wavLength(settings);

    // ---- Step 1: bytes=0-1 -----------------------------------------------
    const r1 = await withTimeout(
        fetchRange(hash, 'bytes=0-1'),
        30_000,
        `${iterLabel} step1 timed out`
    );
    assertEquals(r1.status, 206,        `${iterLabel} step1: expected 206`);
    assertEquals(r1.totalBytes, 2,      `${iterLabel} step1: expected 2 bytes`);
    assertEquals(r1.firstBytes[0], 0x52, `${iterLabel} step1: byte 0 should be R`);
    assertEquals(r1.firstBytes[1], 0x49, `${iterLabel} step1: byte 1 should be I`);

    // ---- Steps 2-3: bytes=0-{total-1}, then cancel -----------------------
    await withTimeout(
        fetchRange(hash, `bytes=0-${total - 1}`, CANCEL_DELAY_MS),
        30_000,
        `${iterLabel} step2 (cancel) timed out`
    );

    // ---- Step 3: tail request --------------------------------------------
    const tailStart = Math.max(WAV_HEADERSIZE, total - TAIL_BYTES);
    const r3 = await withTimeout(
        fetchRange(hash, `bytes=${tailStart}-${total - 1}`),
        60_000,
        `${iterLabel} step3 (tail) timed out`
    );
    assertEquals(r3.status, 206,                        `${iterLabel} step3: expected 206`);
    assertEquals(r3.totalBytes, total - tailStart,     `${iterLabel} step3: unexpected byte count`);

    // ---- Step 4: bytes=0-1445 --------------------------------------------
    const r4 = await withTimeout(
        fetchRange(hash, 'bytes=0-1445'),
        30_000,
        `${iterLabel} step4 timed out`
    );
    assertEquals(r4.status, 206,    `${iterLabel} step4: expected 206`);
    assertEquals(r4.totalBytes, 1446, `${iterLabel} step4: expected 1446 bytes`);

    // ---- Step 5: playing position, limited to 2 s, then cancel ----------
    // Playing position at 10 % into the PCM data, aligned to frame boundary.
    const rawPos = WAV_HEADERSIZE + Math.floor((total - WAV_HEADERSIZE) * 0.10);
    const playStart = rawPos - (rawPos % BYTESPERPCMFRAME);
    const playEnd   = Math.min(total - 1, playStart + PLAY_RANGE_BYTES - 1);
    await withTimeout(
        fetchRange(hash, `bytes=${playStart}-${total - 1}`, PLAY_DURATION_S*1000),
        120_000,
        `${iterLabel} step5 (play) timed out`
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite.test('service worker is active', async () => {
    const reg = await navigator.serviceWorker.getRegistration('./');
    assert(!!reg,        'service worker not registered');
    assert(!!reg.active, 'service worker not active');
});

let baseSettings;

suite.test('song is in SW cache', async () => {
    baseSettings = await withTimeout(getCachedSettingsLastOpenedSong(), 5_000, 'cache read timed out');
    assert(!!baseSettings.midiFileHash, 'settings has no midiFileHash');
    assert(!!baseSettings.duration_s,   'settings has no duration_s');
    assert(!!baseSettings.playbackRate, 'settings has no playbackRate');
});

suite.test('iOS sequence iteration 1 (original settings)', async () => {
    assert(!!baseSettings, 'prerequisite: song must be cached');
    await runIosSequence(baseSettings, 'iter1');
});

suite.test('iOS sequence iteration 2 (settings change #1: playbackRate ×0.5)', async () => {
    assert(!!baseSettings);
    const s2 = {
        ...baseSettings,
        playbackRate: parseFloat((baseSettings.playbackRate * 0.5).toFixed(4))
    };
    s2.wavLength_bytes = wavLength(s2);
    await storeSettings(`./settings/${s2.midiFileHash}`, s2);
    await runIosSequence(s2, 'iter2');
    // Restore original settings for the next test
    await storeSettings(`./settings/${baseSettings.midiFileHash}`, baseSettings);
});

suite.test('iOS sequence iteration 3 (settings change #2: playbackRate ×0.75)', async () => {
    assert(!!baseSettings);
    const s3 = {
        ...baseSettings,
        playbackRate: parseFloat((baseSettings.playbackRate * 0.75).toFixed(4))
    };
    s3.wavLength_bytes = wavLength(s3);
    await storeSettings(`./settings/${s3.midiFileHash}`, s3);
    await runIosSequence(s3, 'iter3');
    // Restore original settings
    await storeSettings(`./settings/${baseSettings.midiFileHash}`, baseSettings);
});
