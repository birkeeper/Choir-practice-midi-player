// import the modules

import { WORKLET_URL_ABSOLUTE } from './libraries/spessasynth_lib/src/spessasynth_lib/synthetizer/worklet_url.js'
import { Sequencer } from './libraries/spessasynth_lib/src/spessasynth_lib/sequencer/sequencer.js'
import { Synthetizer } from './libraries/spessasynth_lib/src/spessasynth_lib/synthetizer/synthetizer.js'
import { midiControllers } from './libraries/spessasynth_lib/src/spessasynth_lib/midi_parser/midi_message.js'
import {ALL_CHANNELS_OR_DIFFERENT_ACTION} from './libraries/spessasynth_lib/src/spessasynth_lib/synthetizer/worklet_system/message_protocol/worklet_message.js'
import { loadSoundFont } from "./libraries/spessasynth_lib/src/spessasynth_lib/soundfont/load_soundfont.js";
import { getPauseSvg, getPlaySvg, getFileOpenSvg } from './js/icons.js'

const VERSION = "v1.1.2.1"
const DEFAULT_PERCUSSION_CHANNEL = 9; // In GM channel 9 is used as a percussion channel
const ICON_SIZE_PX = 24; // size of button icons

let instruments; // map of midi instruments to secondary soundfont preset numbers
const SOUNDFONTBANK = 1; // bank where the secondary soundfont needs to be loaded
const SOUNDFONT_GM = "./soundfonts/GeneralUserGS.sf3"; // General Midi soundfont
const SOUNTFONT_SPECIAL = "./soundfonts/Choir_practice.sf2"; //special soundfont

async function generateHash(fileBuffer) {
    const hashBuffer = await crypto.subtle.digest('SHA-1', fileBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
} 

if ("serviceWorker" in navigator) {
    // Register a service worker hosted at the root of the
    // site using the default scope.
    navigator.serviceWorker.register("./service-worker.js").then(
      (registration) => {
        console.log("Service worker registration succeeded:", registration);
        if (registration.installing) {
            console.log("Service worker installing");
        } else if (registration.waiting) {
            console.log("Service worker installed");
        } else if (registration.active) {
            console.log("Service worker active");
        }
        registration.update(); // Check for updates immediately
      },
      (error) => {
        console.error(`Service worker registration failed: ${error}`);
      },
    );
} else {
    console.error("Service workers are not supported.");
}

// Function to store settings
async function storeSettings(hash, settings) {
    if (navigator.serviceWorker.controller) {
        console.log(`storing settings (hash: ${hash}`);
        navigator.serviceWorker.controller.postMessage({
            type: 'storeSettings',
            hash: hash,
            settings: settings
        });
    }
}

// Function to retrieve settings
async function retrieveSettings(hash) {
    if (navigator.serviceWorker.controller) {
        return new Promise((resolve) => {
            const messageChannel = new MessageChannel();
            messageChannel.port1.onmessage = (event) => {
                resolve(event.data.settings);
                if (event.data.settings === null) {
                    console.log("settings not found");
                }
                else {
                    console.log("settings retrieved");
                }
            };
            console.log(`retrieving settings (hash: ${hash})`);
            navigator.serviceWorker.controller.postMessage({
                type: 'retrieveSettings',
                hash: hash
            }, [messageChannel.port2]);
        });
    }
    return null;
}

document.getElementById('title').textContent = 'Midi Player '+ VERSION;
document.getElementById("pause-label").innerHTML = getPlaySvg(ICON_SIZE_PX);
document.getElementById("midi_input-label").innerHTML = getFileOpenSvg(ICON_SIZE_PX);

// load the soundfont
fetch(SOUNTFONT_SPECIAL).then(async response => {
    // load the soundfont into an array buffer
    let secondarySoundFontBuffer = response.arrayBuffer();
    let primarySoundFontBuffer;
    await fetch(SOUNDFONT_GM).then(async response => {
        primarySoundFontBuffer = await response.arrayBuffer();
    });
    
    // create the context and add audio worklet
    const context = new AudioContext({latencyHint: "playback"});
    await context.audioWorklet.addModule(new URL("./libraries/spessasynth_lib/src/spessasynth_lib/" + WORKLET_URL_ABSOLUTE, import.meta.url));
    const synth = new Synthetizer(context.destination, primarySoundFontBuffer, undefined, undefined, {chorusEnabled: false, reverbEnabled: false});     // create the synthetizer
    {
        const soundFont = loadSoundFont(await secondarySoundFontBuffer);
        instruments = {...soundFont.presets};
    }
    document.getElementById("message").innerText = "Select a midi file. Give your browser \"music and audio\" permisions.";
    for (const instrument of Object.values(instruments)) { //adjust soundfont presets to new bank
        instrument.bank = SOUNDFONTBANK;
    }
    await synth.isReady;
    await synth.soundfontManager.addNewSoundFont(await secondarySoundFontBuffer,"secondary",SOUNDFONTBANK);
    document.getElementById("midi_input").disabled = false;

    let seq;
    let channels;
    // add an event listener for the file inout
    document.getElementById("midi_input").addEventListener("change", async event => {
        // check if any files are added
        let file = event.target.files[0];
        if (!file) {
            return;
        }

        if (!(file.type === 'audio/midi' || file.type === 'audio/x-midi' || file.type === 'audio/mid')) { //incorrect file type
            document.getElementById("message").innerText = "Incorrect file type. Select a midi file.";
            return;
        }

        // resume the context if paused
        await context.resume();

        // store settings if a song has been loaded before
        if (channels !== undefined) {
            storeSettings(await generateHash(buffer), channels);
        }

        // parse all the files
        const parsedSongs = [];
        const buffer = await file.arrayBuffer();
        parsedSongs.push({
            binary: buffer,     // binary: the binary data of the file
            altName: file.name  // altName: the fallback name if the MIDI doesn't have one. Here we set it to the file name
        });
        
        if(seq === undefined)
        {
            seq = new Sequencer(parsedSongs, synth, {skipToFirstNoteOn: false,});                          // create the sequencer with the parsed midis
        }
        else
        {
            for (const channel of channels) {// unlock all channel controllers of the previous song, so it can be overwritten.
                synth.lockController(channel, ALL_CHANNELS_OR_DIFFERENT_ACTION, false);
                synth.lockController(channel, midiControllers.bankSelect, false);
            }
            seq.loadNewSongList(parsedSongs); // the sequencer is already created, no need to create a new one.
        }
        seq.loop = false; // the sequencer loops a single song by default

        // make the slider move with the song and define what happens when the user moves the slider
        const slider = document.getElementById("progress");
        const currentTimeDisplay = document.getElementById('currentTime');
        const totalTimeDisplay = document.getElementById('totalTime');
        let timerID = setInterval(timerCallback, 500);
        slider.oninput = () => {
            currentTimeDisplay.textContent = formatTime(Number(slider.value));
        };
        slider.onmousedown = handleClickProgressSlider;
        slider.onmouseup = handleReleaseProgressSlider;
        slider.ontouchstart = handleClickProgressSlider;
        slider.ontouchend = handleReleaseProgressSlider;
        function handleClickProgressSlider() {
            clearInterval(timerID);
        }
        function handleReleaseProgressSlider() {
            seq.currentTime = Number(slider.value);
            timerID = setInterval(timerCallback, 500);
            document.getElementById("pause-label").innerHTML = getPauseSvg(ICON_SIZE_PX);   // song will automatically play when currentTime is changed
        }
        function timerCallback() {
            slider.value = Math.floor(seq.currentTime);
            currentTimeDisplay.textContent = formatTime(seq.currentTime);            
        }
        function formatTime(seconds) {
            const minutes = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        }

        // make a slider to set the playback rate
        const playbackRateInput = document.getElementById('playbackRate');
        const playbackRateValue = document.getElementById('playbackRateValue');
        playbackRateInput.addEventListener('input', function() {
            seq.playbackRate = playbackRateInput.value;
            playbackRateValue.textContent = `${Number(playbackRateInput.value).toFixed(1)}x`;
            document.getElementById("pause-label").innerHTML = getPauseSvg(ICON_SIZE_PX);   // song will play automatically when playbackRate is changed
        });

        // on song change, show the name
        seq.addOnSongChangeEvent(async e => {
            document.getElementById("message").innerText = e.midiName;
            document.getElementById("pause-label").innerHTML = getPauseSvg(ICON_SIZE_PX);   // song will play automatically when song is changed.

            //update progress slider
            slider.max = Math.floor(seq.duration);
            totalTimeDisplay.textContent = formatTime(seq.duration);
            
            // create channel controls
            const channelControlsContainer = document.getElementById('channel-controls');
            channelControlsContainer.innerHTML = ''; // Clear existing controls

            // read channel settings from cache if available
            channels = await retrieveSettings(await generateHash(buffer));
            if (channels === null) { // no channel settings found in the cache
                channels = [];
                let nrOfTracks = e.tracksAmount;
                const channelsPerTrack = e.usedChannelsOnTrack;
                const channelNumbers = new Set([...channelsPerTrack.flatMap(set => [...set])]); // unique channels in the midi file
                channelNumbers.forEach(channelNumber => {
                    const channelSettings = {
                        name: `${channelNumber}`,
                        number: channelNumber,
                        pan: Math.round((127*channelNumber)/(channelNumbers.size-1)), // automatically pans the channels from left to right range [0,127], 64 represents middle. This makes the channels more discernable., // Example default panning value (center)
                        volume: 85, // Example default volume value
                        selectedInstrument: "Default"
                    };
                    channels.push(channelSettings);
                });
            }    
            console.log(channels);

            const instrumentControls = new Map(); // array of instrument controls to be able to control them
            for (const channel of channels) {
                const channelControl = createChannelControl(channel, synth, instrumentControls);
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
                                options[i].value = `${bank}:${e.program}`;
                                console.log(`default option set to preset ${e.channel}:${bank}:${e.program}`);
                                break;
                    
                            }
                        }
                    }
                }
            });
            
            function createChannelControl(channel, synth, instrumentControls) {
                const container = document.createElement('div');
                container.className = 'channel-control';
            
                const nameLabel = document.createElement('span');
                nameLabel.className = 'channel-name';
                nameLabel.textContent = channel.name;
                container.appendChild(nameLabel);
            
                const volumeSlider = document.createElement('input');
                volumeSlider.type = 'range';
                volumeSlider.className = 'volume-slider';
                volumeSlider.min = 0;
                volumeSlider.max = 127;
                volumeSlider.value = channel.volume;
                synth.lockController(channel.number, midiControllers.mainVolume, false);
                synth.controllerChange (channel.number, midiControllers.mainVolume, volumeSlider.value);
                synth.lockController(channel.number, midiControllers.mainVolume, true);
                volumeSlider.onchange = () => {
                    synth.lockController(channel.number, midiControllers.mainVolume, false);
                    synth.controllerChange (channel.number, midiControllers.mainVolume, volumeSlider.value);
                    synth.lockController(channel.number, midiControllers.mainVolume, true);
                }
                container.appendChild(volumeSlider);
            
                const instrumentSelect = document.createElement('select');
                instrumentSelect.className = 'instrument-select'
                const option = document.createElement('option');
                option.value = ""
                option.textContent = "Default"
                if (channel.selectedInstrument === "Default") {
                    option.selected = true;
                } else {option.selected = false;}
                instrumentSelect.appendChild(option);
                
                if (channel.number === DEFAULT_PERCUSSION_CHANNEL) { synth.channelProperties[channel].isDrum = true; }
                if (!synth.channelProperties[channel.number].isDrum) { // do not have interactive drop-down menu when the channel is used for percussion.
                    for (const instrument of Object.values(instruments)) {
                        const option = document.createElement('option');
                        option.value = `${instrument.bank}:${instrument.program}`;
                        option.textContent = instrument.presetName;
                        if (channel.selectedInstrument === "instrument.presetName") {
                            option.selected = true;
                        } else {option.selected = false;}
                        instrumentSelect.appendChild(option);
                    }
                    instrumentSelect.addEventListener('change', function(event) {
                        let data = event.target.value.split(":").map(value => parseInt(value, 10)); // bank:program
                        synth.lockController(channel.number, midiControllers.bankSelect, false)
                        synth.controllerChange (channel.number, midiControllers.bankSelect, data[0]);
                        synth.lockController(channel.number, midiControllers.bankSelect, true);
                        currentBank.set(channel.number, data[0]);
                        synth.lockController(channel.number, ALL_CHANNELS_OR_DIFFERENT_ACTION, false);
                        synth.programChange(channel.number, data[1]);
                        synth.lockController(channel.number, ALL_CHANNELS_OR_DIFFERENT_ACTION, true);
                        console.log(`changing channel ${channel.number} to instrument ${event.target.value}`)
                    });
                    instrumentControls.set(channel,instrumentSelect);
                }
                container.appendChild(instrumentSelect);
            
                //set and lock modulation wheel, because it seems to be used a lot and creates a kind of vibrato, that is not pleasant
                synth.lockController(channel.number, midiControllers.modulationWheel, false);
                synth.controllerChange (channel.number, midiControllers.modulationWheel, 0);
                synth.lockController(channel.number, midiControllers.modulationWheel, true);
            
                //set and lock the pan of the channel
                synth.lockController(channel.number, midiControllers.pan, false);
                synth.controllerChange (channel.number, midiControllers.pan, channel.pan);
                synth.lockController(channel.number, midiControllers.pan, true);
            
                return container;
            }
            
        }, "example-time-change"); // make sure to add a unique id!

        // on pause click
        document.getElementById("pause").onclick = () => {
            if (seq.paused) {
                document.getElementById("pause-label").innerHTML = getPauseSvg(ICON_SIZE_PX);
                seq.play(); // resume
            }
            else {
                document.getElementById("pause-label").innerHTML = getPlaySvg(ICON_SIZE_PX);
                seq.pause(); // pause

            }
        }
    });
});






