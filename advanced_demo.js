// import the modules

import { WORKLET_URL_ABSOLUTE } from './libraries/spessasynth_lib/src/spessasynth_lib/synthetizer/worklet_url.js'
import { Sequencer } from './libraries/spessasynth_lib/src/spessasynth_lib/sequencer/sequencer.js'
import { Synthetizer } from './libraries/spessasynth_lib/src/spessasynth_lib/synthetizer/synthetizer.js'
import { midiControllers } from './libraries/spessasynth_lib/src/spessasynth_lib/midi_parser/midi_message.js'
import {ALL_CHANNELS_OR_DIFFERENT_ACTION} from './libraries/spessasynth_lib/src/spessasynth_lib/synthetizer/worklet_system/message_protocol/worklet_message.js'
import { loadSoundFont } from "./libraries/spessasynth_lib/src/spessasynth_lib/soundfont/load_soundfont.js";

const DEFAULT_PERCUSSION_CHANNEL = 9; // In GM channel 9 is used as a percussion channel

let instruments; // map of midi instruments to secondary soundfont preset numbers
const SOUNDFONTBANK = 1; // bank where the secondary soundfont needs to be loaded

// load the soundfont
fetch("./soundfonts/GeneralUserGS.sf3").then(async response => {
    // load the soundfont into an array buffer
    let primarySoundFontBuffer = await response.arrayBuffer();
    let secondarySoundFontBuffer;
    fetch("./soundfonts/KBH-Real-Choir-V2.5.sf2").then(async response => {
        secondarySoundFontBuffer = await response.arrayBuffer();
    });
    document.getElementById("message").innerText = "SoundFont has been loaded!";

    // create the context and add audio worklet
    const context = new AudioContext({latencyHint: "playback"});
    await context.audioWorklet.addModule(new URL("./libraries/spessasynth_lib/src/spessasynth_lib/" + WORKLET_URL_ABSOLUTE, import.meta.url));
    const synth = new Synthetizer(context.destination, primarySoundFontBuffer, undefined, undefined, {chorusEnabled: false, reverbEnabled: false});     // create the synthetizer
    await synth.isReady;
    await synth.soundfontManager.addNewSoundFont(secondarySoundFontBuffer,"secondary",SOUNDFONTBANK);
    {
        const soundFont = loadSoundFont(secondarySoundFontBuffer);
        instruments = {...soundFont.presets};
    }
    for (const instrument of instruments) { //adjust soundfont presets to new bank
        instrument.bank = SOUNDFONTBANK;
    }



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
        const parsedSongs = [];
        for (let file of event.target.files) {
            const buffer = await file.arrayBuffer();
            parsedSongs.push({
                binary: buffer,     // binary: the binary data of the file
                altName: file.name  // altName: the fallback name if the MIDI doesn't have one. Here we set it to the file name
            });
        }
        if(seq === undefined)
        {
            seq = new Sequencer(parsedSongs, synth, {autoPlay: false});                          // create the sequencer with the parsed midis
        }
        else
        {
            seq.loadNewSongList(parsedSongs, autoPlay = false); // the sequencer is already created, no need to create a new one.
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
            synth.resetControllers();
                        
            let nrOfTracks = e.tracksAmount;
            const channelsPerTrack = e.usedChannelsOnTrack;
            const channels = new Set([...channelsPerTrack.flatMap(set => [...set])]); // unique channels in the midi file
            const instrumentControls = new Map(); // array of instrument controls to be able to control them
            for (const channel of channels) {
                let pan = Math.round((127*channel)/(channels.size-1)); // automatically pans the channels from left to right range [0,127], 64 represents middle. This makes the channels more discernable.
                const channelControl = createChannelControl(channel, synth, pan, instrumentControls);
                channelControlsContainer.appendChild(channelControl);
            }
            
            const currentBank = new Map();
            synth.eventHandler.removeEvent("controllerchange","controller-change-event");
            synth.eventHandler.addEvent("controllerchange","controller-change-event", e => {
                if (e.controllerNumber === 0) { // bank select
                    console.log(`controller change to ${e.channel}:${e.controllerNumber}:${e.controllerValue}`);
                    currentBank.set(e.channel, e.controllerValue);
                }
            });

            synth.eventHandler.removeEvent("programchange","program-change-event");
            synth.eventHandler.addEvent("programchange","program-change-event", e => {
                let bank = currentBank.get(e.channel) === undefined ? 0 : currentBank.get(e.channel);
                console.log(`program change to preset ${e.channel}:${bank}:${e.program}`);
                if (instrumentControls.has(e.channel)) {
                    const options = instrumentControls.get(e.channel);
                    if ( bank === 0) { // change the default setting to the latest instrument that is to bank 0 for the indicated channel
                        for (let i=0; i<options.length; i++) {
                            if (options[i].textContent === "Default") {
                                let data = options[i].value.split(":").map(value => parseInt(value, 10)); // bank:program
                                options[i].value = `${bank}:${e.program}`;
                                console.log(`default option set to preset ${e.channel}:${bank}:${e.program}`);
                                break;
                    
                            }
                        }
                    }
                }
            });
            
            function createChannelControl(channel, synth, pan, instrumentControls) {
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
            
                const instrumentSelect = document.createElement('select');
                const option = document.createElement('option');
                option.value = ""
                option.textContent = "Default"
                option.selected = true;
                instrumentSelect.appendChild(option);
                
                if (channel === DEFAULT_PERCUSSION_CHANNEL) { synth.channelProperties[channel].isDrum = true; }
                if (!synth.channelProperties[channel].isDrum) { // do not have interactive drop-down menu when the channel is used for percussion.
                    for (const instrument of instruments) {
                        const option = document.createElement('option');
                        option.value = `${instrument.bank}:${instrument.program}`;
                        option.textContent = instrument.presetName;
                        instrumentSelect.appendChild(option);
                    }
                    instrumentSelect.addEventListener('change', function(event) {
                        let data = event.target.value.split(":").map(value => parseInt(value, 10)); // bank:program
                        synth.lockController(channel, midiControllers.bankSelect, false)
                        synth.controllerChange (channel, midiControllers.bankSelect, data[0]);
                        synth.lockController(channel, midiControllers.bankSelect, true);
                        currentBank.set(channel, data[0]);
                        synth.lockController(channel, ALL_CHANNELS_OR_DIFFERENT_ACTION, false);
                        synth.programChange(channel, data[1]);
                        synth.lockController(channel, ALL_CHANNELS_OR_DIFFERENT_ACTION, true);
                        console.log(`changing channel ${channel} to instrument ${event.target.value}`)
                    });
                    instrumentControls.set(channel,instrumentSelect);
                }
                container.appendChild(instrumentSelect);
            
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






