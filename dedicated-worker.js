import { WORKLET_URL_ABSOLUTE, Sequencer, Synthetizer } from './libraries/spessasynth_lib/index.js';
import { midiControllers, ALL_CHANNELS_OR_DIFFERENT_ACTION, loadSoundFont, MIDI, audioToWav, SpessaSynthSequencer, SpessaSynthProcessor } from './libraries/spessasynth_core/index.js';
import { SOUNDFONT_GM, SOUNTFONT_SPECIAL, SOUNDFONTBANK } from "./constants.js";

console.log("initalising dedicated worker...");

// load the soundfonts
const [responseSecondary, responsePrimary] = await Promise.all([fetch(SOUNTFONT_SPECIAL), fetch(SOUNDFONT_GM)]);
// load the soundfonts into array buffers
const [secondarySoundFontBuffer, primarySoundFontBuffer] = await Promise.all([responseSecondary.arrayBuffer(), responsePrimary.arrayBuffer()]);
const sampleRate = 44100;
const synth = new SpessaSynthProcessor(sampleRate, {
    enableEventSystem: false,
    effectsEnabled: false
});
synth.soundfontManager.reloadManager(loadSoundFont(primarySoundFontBuffer));
synth.soundfontManager.addNewSoundFont(loadSoundFont(secondarySoundFontBuffer),"secondary",SOUNDFONTBANK);

self.onmessage = (msg) => {
    console.log("message received in dedicated worker");
    midiToWav(msg.data);
};

async function midiToWav(midi) {
    const sampleCount = Math.ceil(44100 * (midi.duration + 2)); 
    await synth.processorInitialized;
    const seq = new SpessaSynthSequencer(synth);
    seq.loadNewSongList([midi]);
    seq.loop = false;
    const outLeft = new Float32Array(sampleCount);
    const outRight = new Float32Array(sampleCount);
    const start = performance.now();
    let filledSamples = 0;
    // note: buffer size is recommended to be very small, as this is the interval between modulator updates and LFO updates
    const BUFFER_SIZE = 128;
    let i = 0;
    const durationRounded = Math.floor(seq.midiData.duration * 100) / 100;
    const outputArray = [outLeft, outRight];
    while (filledSamples < sampleCount)
    {
        // process sequencer
        seq.processTick();
        // render
        const bufferSize = Math.min(BUFFER_SIZE, sampleCount - filledSamples);
        synth.renderAudio(outputArray, [], [], filledSamples, bufferSize);
        filledSamples += bufferSize;
        i++;
    }
    const rendered = Math.floor(performance.now() - start);
    console.info("Rendered in", rendered, `ms (${Math.floor((midi.duration * 1000 / rendered) * 100) / 100}x)`);
    const wave = audioToWav(
        [outLeft, outRight],
        sampleRate
    );
    const completed = Math.floor(performance.now() - start);
    console.info("completed in", completed, `ms`);
}

console.log("dedicated worker initialised");