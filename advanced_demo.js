// import the modules

import { WORKLET_URL_ABSOLUTE } from './libraries/spessasynth_lib/src/spessasynth_lib/synthetizer/worklet_url.js'
import { Sequencer } from './libraries/spessasynth_lib/src/spessasynth_lib/sequencer/sequencer.js'
import { Synthetizer } from './libraries/spessasynth_lib/src/spessasynth_lib/synthetizer/synthetizer.js'
import { midiControllers } from './libraries/spessasynth_lib/src/spessasynth_lib/midi_parser/midi_message.js'
import { getUsedProgramsAndKeys } from './libraries/spessasynth_lib/src/spessasynth_lib/midi_parser/used_keys_loaded.js'
import { MIDI } from './libraries/spessasynth_lib/src/spessasynth_lib/midi_parser/midi_loader.js'


const DEFAULT_PERCUSSION_CHANNEL = 9; // In GM channel 9 is used as a percussion channel

// load the soundfont
fetch("./soundfonts/GeneralUserGS.sf3").then(async response => {
    // load the soundfont into an array buffer
    let soundFontBuffer = await response.arrayBuffer();
    document.getElementById("message").innerText = "SoundFont has been loaded!";

    // create the context and add audio worklet
    const context = new AudioContext({latencyHint: "playback"});
    await context.audioWorklet.addModule(new URL("./libraries/spessasynth_lib/src/spessasynth_lib/" + WORKLET_URL_ABSOLUTE, import.meta.url));
    const synth = new Synthetizer(context.destination, soundFontBuffer, undefined, undefined, {chorusEnabled: false, reverbEnabled: false});     // create the synthetizer
    let seq;

    // add an event listener for the file inout
    document.getElementById("midi_input").addEventListener("change", async event => {
        // check if any files are added
        if (!event.target.files[0]) {
            return;
        }
        // resume the context if paused
        await context.resume();
        // parse all the files
        const parsedSong = [];
        let file = event.target.files [0];
        const buffer = await file.arrayBuffer();
        parsedSong.push({
                binary: buffer,     // binary: the binary data of the file
                altName: file.name  // altName: the fallback name if the MIDI doesn't have one. Here we set it to the file name
            });
        const parsedMidi = new MIDI(parsedSong[0].binary);
        if(seq === undefined)
        {
            seq = new Sequencer(parsedSong, synth);                          // create the sequencer with the parsed midis
            seq.play();                                                             // play the midi
        }
        else
        {
            seq.loadNewSongList(parsedSong); // the sequencer is already created, no need to create a new one.
        }
        seq.loop = false;                                                       // the sequencer loops a single song by default

        // make the slider move with the song
        let slider = document.getElementById("progress");
        setInterval(() => {
            // slider ranges from 0 to 1000
            slider.value = (seq.currentTime / seq.duration) * 1000;
        }, 100);

        // on song change, show the name
        seq.addOnSongChangeEvent(e => {
            document.getElementById("message").innerText = "Now playing: " + e.midiName;
            
            const channelControlsContainer = document.getElementById('channel-controls');
            channelControlsContainer.innerHTML = ''; // Clear existing controls
            
            let preset = getUsedProgramsAndKeys(parsedMidi, synth.soundfontManager);
            console.log(preset);
            
            let nrOfTracks = e.tracksAmount;
            const channelsPerTrack = e.usedChannelsOnTrack;
            const channels = new Set([...channelsPerTrack.flatMap(set => [...set])]); // unique channels in the midi file
            for (const channel of channels) {
                let pan = Math.round((127*channel)/(channels.size-1)); // automatically pans the channels from left to right range [0,127], 64 represents middle. This makes the channels more discernable.
                const channelControl = createChannelControl(channel, synth, pan);
                channelControlsContainer.appendChild(channelControl);
            }
        }, "example-time-change"); // make sure to add a unique id!

        // add time adjustment
        slider.onchange = () => {
            // calculate the time
            seq.currentTime = (slider.value / 1000) * seq.duration; // switch the time (the sequencer adjusts automatically)
        }

        // on pause click
        document.getElementById("pause").onclick = () => {
            if (seq.paused) {
                document.getElementById("pause").innerText = "Pause";
                seq.play(); // resume
            }
            else {
                document.getElementById("pause").innerText = "Resume";
                seq.pause(); // pause

            }
        }
    });
});

const INSTRUMENTS = new Map([['Piano', 0], ['Clarinet', 71]]); // map of midi instruments to soundfont preset numbers

function createChannelControl(channel, synth, pan) {
    const container = document.createElement('div');
    container.className = 'channel-control';

    const nameLabel = document.createElement('span');
    nameLabel.className = 'channel-name';
    nameLabel.textContent = channel;
    container.appendChild(nameLabel);

    const volumeSlider = document.createElement('input');
    volumeSlider.type = 'range';
    volumeSlider.className = 'volume-slider';
    volumeSlider.min = 0;
    volumeSlider.max = 127;
    volumeSlider.value = 127;
    synth.lockController(channel, midiControllers.mainVolume, false);
    synth.controllerChange (channel, midiControllers.mainVolume, volumeSlider.value);
    synth.lockController(channel, midiControllers.mainVolume, true);
    volumeSlider.onchange = () => {
        synth.lockController(channel, midiControllers.mainVolume, false);
        synth.controllerChange (channel, midiControllers.mainVolume, volumeSlider.value);
        synth.lockController(channel, midiControllers.mainVolume, true);
    }
    container.appendChild(volumeSlider);

    if (channel === DEFAULT_PERCUSSION_CHANNEL) { synth.channelProperties[channel].isDrum = true; }
    if (!synth.channelProperties[channel].isDrum) { // do not show instrument drop-down menu when the channel is used for percussion.
        const instrumentSelect = document.createElement('select');
        for (const [instrument, preset] of INSTRUMENTS) {
            const option = document.createElement('option');
            option.value = instrument;
            option.textContent = instrument;
            if (instrument === 'Clarinet') {
                option.selected = true;
                synth.programChange(channel, preset);
            }
            instrumentSelect.appendChild(option);
        }
        instrumentSelect.addEventListener('change', function(event) {synth.programChange(channel, INSTRUMENTS.get(event.target.value));});
        container.appendChild(instrumentSelect);
    }

    //set and lock modulation wheel, because it seems to be used a lot and creates a kind of vibrato, that is not pleasant
    synth.lockController(channel, midiControllers.modulationWheel, false);
    synth.controllerChange (channel, midiControllers.modulationWheel, 0);
    synth.lockController(channel, midiControllers.modulationWheel, true);

    //set and lock the pan of the channel
    synth.lockController(channel, midiControllers.pan, false);
    synth.controllerChange (channel, midiControllers.pan, pan);
    synth.lockController(channel, midiControllers.pan, true);

    return container;
}
