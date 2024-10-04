// import the modules

import { WORKLET_URL_ABSOLUTE } from './libraries/spessasynth_lib/src/spessasynth_lib/synthetizer/worklet_url.js'
import { Sequencer } from './libraries/spessasynth_lib/src/spessasynth_lib/sequencer/sequencer.js'
import { Synthetizer } from './libraries/spessasynth_lib/src/spessasynth_lib/synthetizer/synthetizer.js'
import { midiControllers } from './libraries/spessasynth_lib/src/spessasynth_lib/midi_parser/midi_message.js'
import { getUsedProgramsAndKeys } from './libraries/spessasynth_lib/src/spessasynth_lib/midi_parser/used_keys_loaded.js'


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

/**
 * @param mid {BasicMIDI}
 * @param soundfont {{getPreset: function(number, number): BasicPreset}}
 * @returns {Object<string, Set<string>>}
 */
function getUsedProgramsAndKeys(mid, soundfont)
{
    console.log("%cSearching for all used programs and keys...");
    // find every bank:program combo and every key:velocity for each. Make sure to care about ports and drums
    const channelsAmount = 16;
    /**
     * @type {{program: number, bank: number, drums: boolean, string: string}[]}
     */
    const channelPresets = [];
    for (let i = 0; i < channelsAmount; i++) {
        const bank = i % 16 === DEFAULT_PERCUSSION ? 128 : 0;
        channelPresets.push({
            program: 0,
            bank: bank,
            drums: i % 16 === DEFAULT_PERCUSSION, // drums appear on 9 every 16 channels,
            string: `${bank}:0`,
        });
    }

    function updateString(ch)
    {
        // check if this exists in the soundfont
        let exists = soundfont.getPreset(ch.bank, ch.program);
        ch.bank = exists.bank;
        ch.program = exists.program;
        ch.string = ch.bank + ":" + ch.program;
        if(!usedProgramsAndKeys[ch.string])
        {
            console.log(`%cDetected a new preset: %c${ch.string}`);
            usedProgramsAndKeys[ch.string] = new Set();
        }
    }
    /**
     * find all programs used and key-velocity combos in them
     * bank:program each has a set of midiNote-velocity
     * @type {Object<string, Set<string>>}
     */
    const usedProgramsAndKeys = {};

    /**
     * indexes for tracks
     * @type {number[]}
     */
    const eventIndexes = Array(mid.tracks.length).fill(0);
    let remainingTracks = mid.tracks.length;
    function findFirstEventIndex()
    {
        let index = 0;
        let ticks = Infinity;
        mid.tracks.forEach((track, i) => {
            if(eventIndexes[i] >= track.length)
            {
                return;
            }
            if(track[eventIndexes[i]].ticks < ticks)
            {
                index = i;
                ticks = track[eventIndexes[i]].ticks;
            }
        });
        return index;
    }
    const ports = mid.midiPorts.slice();
    // check for xg
    let system = "gs";
    while(remainingTracks > 0)
    {
        let trackNum = findFirstEventIndex();
        const track = mid.tracks[trackNum];
        if(eventIndexes[trackNum] >= track.length)
        {
            remainingTracks--;
            continue;
        }
        const event = track[eventIndexes[trackNum]];
        eventIndexes[trackNum]++;

        if(event.messageStatusByte === messageTypes.midiPort)
        {
            ports[trackNum] = event.messageData[0];
            continue;
        }
        const status = event.messageStatusByte & 0xF0;
        if(
            status !== messageTypes.noteOn &&
            status !== messageTypes.controllerChange &&
            status !== messageTypes.programChange &&
            status !== messageTypes.systemExclusive
        )
        {
            continue;
        }
        const channel = (event.messageStatusByte & 0xF) + mid.midiPortChannelOffsets[ports[trackNum]] || 0;
        let ch = channelPresets[channel];
        switch(status)
        {
            case messageTypes.programChange:
                ch.program = event.messageData[0];
                updateString(ch);
                break;

            case messageTypes.controllerChange:
                if(event.messageData[0] !== midiControllers.bankSelect)
                {
                    // we only care about bank select
                    continue;
                }
                if(system === "gs" && ch.drums)
                {
                    // gs drums get changed via sysex, ignore here
                    continue;
                }
                const bank = event.messageData[1];
                const realBank = Math.max(0, bank - mid.bankOffset);
                if(system === "xg")
                {
                    // check for xg drums
                    const drumsBool = bank === 120 || bank === 126 || bank === 127;
                    if(drumsBool !== ch.drums)
                    {
                        // drum change is a program change
                        ch.drums = drumsBool;
                        ch.bank = ch.drums ? 128 : realBank;
                        updateString(ch);
                    }
                    else
                    {
                        ch.bank = ch.drums ? 128 : realBank;
                    }
                    continue;
                }
                channelPresets[channel].bank = realBank;
                // do not update the data, bank change doesnt change the preset
                break;

            case messageTypes.noteOn:
                if(event.messageData[1] === 0)
                {
                    // that's a note off
                    continue;
                }
                updateString(ch);
                usedProgramsAndKeys[ch.string].add(`${event.messageData[0]}-${event.messageData[1]}`);
                break;

            case messageTypes.systemExclusive:
                // check for drum sysex
                if(
                    event.messageData[0] !== 0x41 || // roland
                    event.messageData[2] !== 0x42 || // GS
                    event.messageData[3] !== 0x12 || // GS
                    event.messageData[4] !== 0x40 || // system parameter
                    (event.messageData[5] & 0x10 ) === 0 || // part parameter
                    event.messageData[6] !== 0x15 // drum pars

                )
                {
                    // check for XG
                    if(
                        event.messageData[0] === 0x43 && // yamaha
                        event.messageData[2] === 0x4C && // sXG ON
                        event.messageData[5] === 0x7E &&
                        event.messageData[6] === 0x00
                    )
                    {
                        system = "xg";
                    }
                    continue;
                }
                const sysexChannel = [9, 0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15][event.messageData[5] & 0x0F] + mid.midiPortChannelOffsets[ports[trackNum]];
                const isDrum = !!(event.messageData[7] > 0 && event.messageData[5] >> 4);
                ch = channelPresets[sysexChannel];
                ch.drums = isDrum;
                ch.bank = isDrum ? 128 : 0;
                updateString(ch);
                break;

        }
    }
    for(const key of Object.keys(usedProgramsAndKeys))
    {
        if(usedProgramsAndKeys[key].size === 0)
        {
            console.log(`%cDetected change but no keys for %c${key}`);
            delete usedProgramsAndKeys[key];
        }
    }
    return usedProgramsAndKeys;
}



