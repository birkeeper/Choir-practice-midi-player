import { loadSoundFont, SpessaSynthSequencer, SpessaSynthProcessor, midiControllers } from './libraries/spessasynth_core/index.js';
//import { midiControllers, ALL_CHANNELS_OR_DIFFERENT_ACTION, loadSoundFont, MIDI} from './libraries/spessasynth_core/index.js';
//import { MidiAudioChannel } from './libraries/spessasynth_core/src/synthetizer/audio_engine/engine_components/midi_audio_channel.js'
import { SOUNDFONT_GM, SOUNTFONT_SPECIAL, SOUNDFONTBANK } from "./constants.js";
import { WAV_NROFCHANNELS, WAV_BITSPERSAMPLE, WAV_SAMPLERATE, WAV_HEADERSIZE } from "./constants.js";
//const MAINVOLUME = 1.5;

console.log("worker: initalising dedicated worker...");
const CHUNCKSIZE = 128 * 100; // [samples] chunck size of the chunck send to the service worker on when receiving a range request. 
// load the soundfonts
const [responseSecondary, responsePrimary] = await Promise.all([fetch(SOUNTFONT_SPECIAL), fetch(SOUNDFONT_GM)]);
// load the soundfonts into array buffers
const [secondarySoundFontBuffer, primarySoundFontBuffer] = await Promise.all([responseSecondary.arrayBuffer(), responsePrimary.arrayBuffer()]);
console.log("worker: soundfonts fetched");
const synth = new SpessaSynthProcessor(WAV_SAMPLERATE, {
    enableEventSystem: false,
    effectsEnabled: false
});
synth.soundfontManager.reloadManager(loadSoundFont(primarySoundFontBuffer));
synth.soundfontManager.addNewSoundFont(loadSoundFont(secondarySoundFontBuffer),"secondary",SOUNDFONTBANK);
const soundFont = loadSoundFont(secondarySoundFontBuffer);
const instruments = {...soundFont.presets}; // map of midi instruments to secondary soundfont preset numbers
for (const instrument of Object.values(instruments)) { //adjust soundfont presets to new bank
	instrument.bank = SOUNDFONTBANK;
}
await synth.processorInitialized;
//synth.setMasterParameter('masterGain', MAINVOLUME);
console.log("worker: synthProcessor initialised");
const seq = new SpessaSynthSequencer(synth);
/*seq.skipToFirstNoteOn = false;
seq.loop = false; // the sequencer loops a single song by default
seq.preservePlaybackState = true;*/
console.log("worker: synthSequencer initialised");

let midi;

self.onmessage = (msg) => {
    console.log(`worker: message received of type: ${msg.data.type}`);
	if (msg.data.type === 'LOAD_MIDI') {
		console.log(`loading midi`);
		midi = msg.data.midi;
		seq.loadNewSongList([midi]);
    	seq.loop = false;
	}
	else if (msg.data.type === 'SetMainVolume') {
		synth.midiAudioChannels[msg.data.channel].lockedControllers[midiControllers.mainVolume] = false;
		synth.controllerChange(msg.data.channel, midiControllers.mainVolume, msg.data.value);
		synth.midiAudioChannels[msg.data.channel].lockedControllers[midiControllers.mainVolume] = true;
	}
	else if (msg.data.type === 'isDrum') {
		synth.midiAudioChannels[msg.data.channel].setDrums(msg.data.boolean);
	}
	else if (msg.data.type === 'bankSelect') {
		synth.midiAudioChannels[msg.data.channel].lockedControllers[midiControllers.bankSelect] = false;
		synth.controllerChange(msg.data.channel, midiControllers.bankSelect, msg.data.value);
		synth.midiAudioChannels[msg.data.channel].lockedControllers[midiControllers.bankSelect] = true;
	}
	else if (msg.data.type === 'programChange') {
		synth.midiAudioChannels[msg.data.channel].lockedControllers[ALL_CHANNELS_OR_DIFFERENT_ACTION] = false;
		synth.programChange(msg.data.channel, msg.data.value);
		synth.midiAudioChannels[msg.data.channel].lockedControllers[ALL_CHANNELS_OR_DIFFERENT_ACTION] = true;
	}
	else if (msg.data.type === 'releaseBankSelect') {
		synth.midiAudioChannels[msg.data.channel].lockedControllers[midiControllers.bankSelect] = false;
	}
	else if (msg.data.type === 'modulationWheel') {
		synth.midiAudioChannels[msg.data.channel].lockedControllers[midiControllers.modulationWheel] = false;
		synth.controllerChange(msg.data.channel, midiControllers.modulationWheel, msg.data.value);
		synth.midiAudioChannels[msg.data.channel].lockedControllers[midiControllers.modulationWheel] = true;
	}
	else if (msg.data.type === 'pan') {
		synth.midiAudioChannels[msg.data.channel].lockedControllers[midiControllers.pan] = false;
		synth.controllerChange(msg.data.channel, midiControllers.pan, msg.data.value);
		synth.midiAudioChannels[msg.data.channel].lockedControllers[midiControllers.pan] = true;
	}
	else if (msg.data.type === 'AUDIO_RANGE_REQ') {
		const port = msg.ports && msg.ports[0];
		if (!port) {return;}
		const start = msg.data.start;
		const end = msg.data.end;
		console.log(`range request received: song hash: ${msg.data.songID}, start: ${start}, end: ${end}`);
		

		try {
			// Send header slice if needed.
			if (start < WAV_HEADERSIZE) {
				const hdr = generateWavHeader();
				const hdrSlice = hdr.slice(start, Math.min(end + 1, WAV_HEADERSIZE));
				port.postMessage({ type: 'chunk', data: hdrSlice.buffer }, [hdrSlice.buffer]);
			}

			// Send PCM bytes if needed.
			const dataLength_bytes = Math.floor(midi.duration * WAV_SAMPLERATE * (WAV_BITSPERSAMPLE/8) * WAV_NROFCHANNELS); // [bytes] length of data section in wave file
			const dataStart_bytes = Math.max(start, WAV_HEADERSIZE) - WAV_HEADERSIZE;
			const dataEndExclusive_bytes = Math.max(Math.min(end + 1 - WAV_HEADERSIZE, dataLength_bytes), 0);
			const start_seconds = dataStart_bytes / WAV_SAMPLERATE / (WAV_BITSPERSAMPLE/8) / WAV_NROFCHANNELS;
			seq.currentTime = start_seconds;
			const dataLength_samples = (dataEndExclusive_bytes - dataStart_bytes) / (WAV_BITSPERSAMPLE/8) / WAV_NROFCHANNELS; // per channel
			let processedSamples = 0;

			port.onmessage = (e) => {
				if (e.data.type === 'reqNextChunk') {
					if (processedSamples < dataLength_samples) { // process in chunks
						const chunkPort = e.ports && e.ports[0];
						const sampleCount = Math.min(CHUNCKSIZE, dataLength_samples - processedSamples);
						sendPCMchunk(chunkPort, sampleCount);
						processedSamples += sampleCount;
					}
					else { // all chuncks processed.
						port.postMessage({ type: 'end' });
      					port.close();
					}
				}
			}
    	} catch (err) {
      		port.postMessage({ type: 'error', message: String(err?.message || err) });
      		port.close();
    	}
	}
};

function sendPCMchunk(port, sampleCount) { // generates  a chunk of PCM data and send it through the port provided. Returns the sample count of the chunk
	const outLeft = new Float32Array(sampleCount);
	const outRight = new Float32Array(sampleCount);
	const outputArray = [outLeft, outRight];
	const outputPCM = new Uint8Array(sampleCount * WAV_NROFCHANNELS * (WAV_BITSPERSAMPLE/8));
	const BUFFER_SIZE = 128; // note: buffer size is recommended to be very small, as this is the interval between modulator updates and LFO updates
	let filledSamples = 0;
	while (filledSamples < sampleCount)
	{
		// process sequencer
		seq.processTick();
		// render
		const bufferSize = Math.min(BUFFER_SIZE, sampleCount - filledSamples);
		synth.renderAudio(outputArray, [], [], filledSamples, bufferSize);
		filledSamples += bufferSize;
	}

	let offset = 0;
	for (let i = 0; i < sampleCount; i++) {
		// Interleave both channels
		for (const d of outputArray) {
			const sample = Math.min(
				32767,
				Math.max(-32768, d[i] * 32767)
			);
			// Convert to 16-bit
			outputPCM[offset++] = sample & 0xff;
			outputPCM[offset++] = (sample >> 8) & 0xff;
		}
	}
	port.postMessage({ type: 'chunk', data: outputPCM.buffer },[outputPCM.buffer]);
}

function generateWavHeader() {
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

console.log("worker: dedicated worker initialised");
self.postMessage({type: 'workerInitalised', instruments: instruments});