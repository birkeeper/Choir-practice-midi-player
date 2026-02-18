//import { WORKLET_URL_ABSOLUTE, Sequencer, Synthetizer } from '../libraries/spessasynth_lib/index.js';
//import { midiControllers, ALL_CHANNELS_OR_DIFFERENT_ACTION, loadSoundFont, MIDI, audioToWav, SpessaSynthSequencer, SpessaSynthProcessor } from '../libraries/spessasynth_core/index.js';
import { loadSoundFont, audioToWav, SpessaSynthSequencer, SpessaSynthProcessor } from './libraries/spessasynth_core/index.js';
import { SOUNDFONT_GM, SOUNTFONT_SPECIAL, SOUNDFONTBANK } from "./constants.js";
import { WAV_NROFCHANNELS, WAV_BITSPERSAMPLE, WAV_SAMPLERATE, WAV_HEADERSIZE } from "./constants.js";

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
	if (msg.data.type === 'LOAD_MIDI') {
		console.log(`loading midi`);
		midiToWav(msg.data.midi);
	}
	if (msg.data.type === 'AUDIO_RANGE_REQ') {
		const port = msg.ports && msg.ports[0];
		if (!port) {return;}
		console.log(`range request received: song hash: ${msg.data.songID}, start: ${msg.data.start}, end: ${msg.data.end}`);
	}
    
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

function generateWavHeader(midi) {
	const dataLength_bytes = Math.floor(midi.duration * WAV_SAMPLERATE * (WAV_BITSPERSAMPLE/8) * WAV_NROFCHANNELS); // [bytes] length of data section in wave file
	const fileSize_bytes = dataLength_bytes + WAV_HEADERSIZE -8; // [bytes] file size -8
	const header = new Uint8Array(WAV_HEADERSIZE);

	// 'RIFF'
    header.set([82, 73, 70, 70], 0);
    // File length
    header.set(
        new Uint8Array([
            fileSize_bytes & 0xff,
            (fileSize_bytes >> 8) & 0xff,
            (fileSize_bytes >> 16) & 0xff,
            (fileSize_bytes >> 24) & 0xff
        ]),
        4
    );
	// 'WAVE'
    header.set([87, 65, 86, 69], 8);
    // 'fmt '
    header.set([102, 109, 116, 32], 12);
    // Fmt chunk length
    header.set([16, 0, 0, 0], 16); // 16 for PCM
    // Audio format (PCM)
    header.set([1, 0], 20);
    // Number of channels
    header.set([WAV_NROFCHANNELS & 255, WAV_NROFCHANNELS >> 8], 22);
    // Sample rate
    header.set(
        new Uint8Array([
            WAV_SAMPLERATE & 0xff,
            (WAV_SAMPLERATE >> 8) & 0xff,
            (WAV_SAMPLERATE >> 16) & 0xff,
            (WAV_SAMPLERATE >> 24) & 0xff
        ]),
        24
    );
	// Byte rate (sample rate * block align)
    const byteRate = WAV_SAMPLERATE * WAV_NROFCHANNELS * (WAV_BITSPERSAMPLE/8); 
    header.set(
        new Uint8Array([
            byteRate & 0xff,
            (byteRate >> 8) & 0xff,
            (byteRate >> 16) & 0xff,
            (byteRate >> 24) & 0xff
        ]),
        28
    );
    // Block align (channels * bytes per sample)
    header.set([WAV_NROFCHANNELS * (WAV_BITSPERSAMPLE/8), 0], 32); // N channels * bits per channel / 8
    // Bits per sample
    header.set([WAV_BITSPERSAMPLE, 0], 34); 
	// Data chunk identifier 'data'
    header.set([100, 97, 116, 97], 36);
    // Data chunk length
    header.set(
        new Uint8Array([
            dataLength_bytes & 0xff,
            (dataLength_bytes >> 8) & 0xff,
            (dataLength_bytes >> 16) & 0xff,
            (dataLength_bytes >> 24) & 0xff
        ]),
        40
    );

	return header;
}

console.log("dedicated worker initialised");