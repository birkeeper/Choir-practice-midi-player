// wav-writer.js
// Pure conversion of rendered float samples into a 16-bit PCM wave file. No worker or browser APIs,
// so it can be unit tested directly.
import { WAV_BITSPERSAMPLE, WAV_HEADERSIZE } from "../constants.js";

export const MASTERGAIN = Math.pow(10, 9 / 20); // identical to the player. NOTE: clipping possible when >1.0

// Converts float samples to interleaved little endian 16-bit PCM and writes them into the wave file at
// `offset`. Mono is the down-mix of both rendered channels. Returns the offset just after the written bytes.
export function writePCM(wav, offset, left, right, frames, mono) {
    for (let i = 0; i < frames; i++) {
        if (mono) {
            const sample = clampSample((left[i] + right[i]) * MASTERGAIN * 32767);
            wav[offset++] = sample & 0xff;
            wav[offset++] = (sample >> 8) & 0xff;
        } else {
            for (const channel of [left, right]) {
                const sample = clampSample(channel[i] * MASTERGAIN * 32767);
                wav[offset++] = sample & 0xff;
                wav[offset++] = (sample >> 8) & 0xff;
            }
        }
    }
    return offset;
}

export function clampSample(sample) {
    return Math.min(32767, Math.max(-32768, sample));
}

export function generateWavHeader(dataLength_bytes, sampleRate, nrOfChannels) {
    const header = new Uint8Array(WAV_HEADERSIZE);
    const view = new DataView(header.buffer);
    const writeString = (offset, string) => { for (let i = 0; i < string.length; i++) { header[offset + i] = string.charCodeAt(i); } };
    writeString(0, "RIFF");
    view.setUint32(4, dataLength_bytes + WAV_HEADERSIZE - 8, true); // file size -8
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true); // fmt chunk length: 16 for PCM
    view.setUint16(20, 1, true); // audio format: PCM
    view.setUint16(22, nrOfChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * nrOfChannels * (WAV_BITSPERSAMPLE / 8), true); // byte rate
    view.setUint16(32, nrOfChannels * (WAV_BITSPERSAMPLE / 8), true); // block align
    view.setUint16(34, WAV_BITSPERSAMPLE, true);
    writeString(36, "data");
    view.setUint32(40, dataLength_bytes, true);
    return header;
}
