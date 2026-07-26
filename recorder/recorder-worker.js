// recorder-worker.js
// Renders a midi file to 16-bit PCM as fast as the CPU allows and returns the complete wave file.
// The synthesis chain (soundfonts, synth processor, sequencer, per channel settings, master gain)
// is identical to dedicated-worker.js, so a recording sounds like the player's output.
import { SoundBankLoader, SpessaSynthSequencer, SpessaSynthProcessor, MIDIControllers, BasicMIDI } from '../libraries/spessasynth_core_dist/index.js';
import { SOUNDFONT_GM, SOUNTFONT_SPECIAL, SOUNDFONTBANK } from "../constants.js";
import { WAV_BITSPERSAMPLE, WAV_HEADERSIZE } from "../constants.js";
import { generateWavHeader, writePCM } from "./wav-writer.js";

const DEFAULT_PERCUSSION_CHANNEL = 9; // In GM channel 9 is used as a percussion channel
const BUFFER_SIZE = 128; // note: buffer size is recommended to be very small, as this is the interval between modulator updates and LFO updates
const CHUNK_SECONDS = 0.5; // [s] amount of audio rendered per iteration; between iterations the worker yields so a cancel can come in

// The soundfonts are cached by the service worker under URLs relative to the app root, so they have
// to be requested with exactly those URLs from this worker one directory below the root.
const APP_ROOT = new URL('../', self.location.href);
const [responseSecondary, responsePrimary] = await Promise.all([
    fetch(new URL(SOUNTFONT_SPECIAL, APP_ROOT)),
    fetch(new URL(SOUNDFONT_GM, APP_ROOT))
]);
const [secondarySoundFontBuffer, primarySoundFontBuffer] = await Promise.all([responseSecondary.arrayBuffer(), responsePrimary.arrayBuffer()]);
console.log("recorder worker: soundfonts fetched");
const primarySoundFont = SoundBankLoader.fromArrayBuffer(primarySoundFontBuffer);
const secondarySoundFont = SoundBankLoader.fromArrayBuffer(secondarySoundFontBuffer);
const instruments = { ...secondarySoundFont.presets }; // map of midi instruments to secondary soundfont preset numbers
for (const instrument of Object.values(instruments)) { // adjust soundfont presets to new bank
    instrument.bank = SOUNDFONTBANK;
}

let midi = null;
let recording = false;
let cancelRequested = false;

self.onmessage = async (msg) => {
    const data = msg.data;
    console.log(`recorder worker: message received of type: ${data.type}`);
    if (data.type === 'LOAD_MIDI') {
        midi = BasicMIDI.fromArrayBuffer(data.buffer, data.name);
        self.postMessage({ type: 'midiLoaded', duration_s: midi.duration });
    } else if (data.type === 'CANCEL') {
        cancelRequested = true; // picked up between two rendered chunks
    } else if (data.type === 'RECORD') {
        if (recording) return;
        if (!midi) {
            self.postMessage({ type: 'error', reason: "no midi file loaded" });
            return;
        }
        recording = true;
        cancelRequested = false;
        try {
            await record(data.settings);
        } catch (err) {
            self.postMessage({ type: 'error', reason: String(err?.message || err) });
        } finally {
            recording = false;
        }
    }
};

async function record(settings) {
    const sampleRate = settings.sampleRate;
    const nrOfChannels = settings.mono ? 1 : 2;
    const bytesPerPCMframe = (WAV_BITSPERSAMPLE / 8) * nrOfChannels;
    // The wave file holds exactly midi.duration seconds of audio, rendered from tick 0 onwards at
    // playback rate 1, so sample n of the output is midi time n / sampleRate: time aligned with the midi.
    const totalFrames = Math.floor(midi.duration * sampleRate);
    if (totalFrames <= 0) {
        self.postMessage({ type: 'error', reason: "the midi file contains no audible events" });
        return;
    }

    const wav = new Uint8Array(WAV_HEADERSIZE + totalFrames * bytesPerPCMframe);
    wav.set(generateWavHeader(totalFrames * bytesPerPCMframe, sampleRate, nrOfChannels), 0);

    const synth = new SpessaSynthProcessor(sampleRate, {
        enableEventSystem: false,
        effectsEnabled: false
    });
    synth.soundBankManager.addSoundBank(primarySoundFont, "primary");
    synth.soundBankManager.addSoundBank(secondarySoundFont, "secondary", SOUNDFONTBANK);
    await synth.processorInitialized;
    const seq = new SpessaSynthSequencer(synth);
    seq.skipToFirstNoteOn = false; // the recording has to start at the start of the midi file, not at its first note
    seq.loadNewSongList([midi]);
    seq.loopCount = 0;
    seq.play();
    applyChannelSettings(synth, settings.channels);
    seq.playbackRate = 1; // a recording is always time aligned with the original midi file
    seq.currentTime = 0;

    function cleanup() {
        try { seq.stop(); } catch (e) {}
        try {
            synth.soundBankManager.soundBankList = []; // detach shared soundfonts before destroy so destroyManager() doesn't call destroySoundBank() on them
            synth.destroySynthProcessor();
        } catch (e) {}
    }

    const chunkFrames = Math.max(BUFFER_SIZE, Math.round(CHUNK_SECONDS * sampleRate / BUFFER_SIZE) * BUFFER_SIZE);
    const outLeft = new Float32Array(chunkFrames);
    const outRight = new Float32Array(chunkFrames);
    let renderedFrames = 0;
    let offset = WAV_HEADERSIZE;

    self.postMessage({ type: 'recordingStarted', duration_s: totalFrames / sampleRate, sampleRate, nrOfChannels });

    while (renderedFrames < totalFrames) {
        if (cancelRequested) {
            cleanup();
            self.postMessage({ type: 'cancelled' });
            return;
        }
        const frames = Math.min(chunkFrames, totalFrames - renderedFrames);
        // renderVoice() adds to the output buffers, so they have to be cleared before every chunk
        outLeft.fill(0);
        outRight.fill(0);
        let filledFrames = 0;
        while (filledFrames < frames) {
            seq.processTick();
            const bufferSize = Math.min(BUFFER_SIZE, frames - filledFrames);
            synth.process(outLeft, outRight, filledFrames, bufferSize);
            filledFrames += bufferSize;
        }
        offset = writePCM(wav, offset, outLeft, outRight, frames, settings.mono);
        renderedFrames += frames;
        self.postMessage({ type: 'progress', recorded_s: renderedFrames / sampleRate, duration_s: totalFrames / sampleRate });
        await new Promise(resolve => setTimeout(resolve, 0)); // let a pending CANCEL message through
    }

    cleanup();
    self.postMessage({
        type: 'done',
        data: wav.buffer,
        sampleRate,
        nrOfChannels,
        duration_s: totalFrames / sampleRate
    }, [wav.buffer]);
}

// Only channels the user actually changed are in the settings, and only the properties that were
// changed are defined: everything else is left to the midi file itself.
function applyChannelSettings(synth, channels) {
    for (const channel of channels ?? []) {
        if (channel.pan !== undefined) setPan(synth, channel.number, channel.pan);
        if (channel.volume !== undefined) setMainVolume(synth, channel.number, channel.volume);
        if (channel.selectedInstrument !== undefined && channel.number !== DEFAULT_PERCUSSION_CHANNEL) {
            for (const instrument of Object.values(instruments)) {
                if (channel.selectedInstrument === instrument.name) {
                    bankSelect(synth, channel.number, instrument.bank);
                    programChange(synth, channel.number, instrument.program);
                }
            }
        }
    }
}

function setPan(synth, channel, pan) {
    synth.midiChannels[channel].lockController(MIDIControllers.pan, false);
    synth.controllerChange(channel, MIDIControllers.pan, pan);
    synth.midiChannels[channel].lockController(MIDIControllers.pan, true);
}

function programChange(synth, channel, program) {
    synth.midiChannels[channel].setSystemParameter("presetLock", false);
    synth.programChange(channel, program);
    synth.midiChannels[channel].setSystemParameter("presetLock", true);
}

function bankSelect(synth, channel, bank) {
    synth.midiChannels[channel].lockController(MIDIControllers.bankSelect, false);
    synth.midiChannels[channel].setSystemParameter("presetLock", false);
    synth.controllerChange(channel, MIDIControllers.bankSelect, bank);
    synth.midiChannels[channel].lockController(MIDIControllers.bankSelect, true);
    synth.midiChannels[channel].setSystemParameter("presetLock", true);
}

function setMainVolume(synth, channel, mainVolume) {
    synth.midiChannels[channel].lockController(MIDIControllers.mainVolume, false);
    synth.controllerChange(channel, MIDIControllers.mainVolume, mainVolume);
    synth.midiChannels[channel].lockController(MIDIControllers.mainVolume, true);
}

console.log("recorder worker: initialised");
self.postMessage({ type: 'workerInitialised', instruments: instruments });
