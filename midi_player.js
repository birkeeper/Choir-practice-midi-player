// import the modules

import { WORKLET_URL_ABSOLUTE } from './libraries/spessasynth_lib/src/spessasynth_lib/synthetizer/worklet_url.js'
import { Sequencer } from './libraries/spessasynth_lib/src/spessasynth_lib/sequencer/sequencer.js'
import { Synthetizer } from './libraries/spessasynth_lib/src/spessasynth_lib/synthetizer/synthetizer.js'
import { midiControllers, MidiMessage } from './libraries/spessasynth_lib/src/spessasynth_lib/midi_parser/midi_message.js'
import {ALL_CHANNELS_OR_DIFFERENT_ACTION} from './libraries/spessasynth_lib/src/spessasynth_lib/synthetizer/worklet_system/message_protocol/worklet_message.js'
import { loadSoundFont } from "./libraries/spessasynth_lib/src/spessasynth_lib/soundfont/load_soundfont.js";
import { getPauseSvg, getPlaySvg, getFileOpenSvg } from './js/icons.js'
import {MIDI} from "./libraries/spessasynth_lib/src/spessasynth_lib/midi_parser/midi_loader.js";


const VERSION = "v1.2.3aj"
const DEFAULT_PERCUSSION_CHANNEL = 9; // In GM channel 9 is used as a percussion channel
const ICON_SIZE_PX = 24; // size of button icons
const MAINVOLUME = 1.5;

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

navigator.serviceWorker.addEventListener("controllerchange", () => {
    console.log("The controller of current browsing context has changed. Reloading the page");
    window.location.reload();
});

// Function to store settings
async function storeSettings(key, settings) {
    if (navigator.serviceWorker.controller) {
        console.log(`storing settings (key: ${key}`);
        if (key === "current_midi_file") {
            const fileURL = URL.createObjectURL(settings); // URL revoked in service worker
            postStoreSettingsMessage(key, fileURL);
            postStoreSettingsMessage("current_midi_file_name", settings.name); // file info is not stored in objectURL, only the blob info.

        } else {
            postStoreSettingsMessage(key, settings);
        }
        async function postStoreSettingsMessage(key, settings) {
            navigator.serviceWorker.controller.postMessage({
                type: 'storeSettings',
                key: `./settings/${key}`,
                settings: settings
            });
        }
    }
}

// Function to retrieve settings
async function retrieveSettings(key) {
    if (navigator.serviceWorker.controller) {
        const response1 = await fetch(`./settings/${key}`);
        if (key ==="current_midi_file") {
            const response2 = await fetch(`./settings/current_midi_file_name`);
            if (response1.ok && response2.ok) {
                const fileName = await response2.json();
                const fileBlob = await response1.blob();
                const file = new File([fileBlob], fileName, {type: `${fileBlob.type}`});
                URL.revokeObjectURL(response1.url);
                return file;
            }
        } else {
            if (response1.ok) {
                return await response1.json();
            }
        }
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
    synth.setMainVolume(MAINVOLUME);

    let seq;
    let settings;
    let midiFileHash;

    async function setupApplication() {
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
            for (const channel of settings.channels) {// unlock all channel controllers of the previous song, so it can be overwritten.
                synth.lockController(channel.number, ALL_CHANNELS_OR_DIFFERENT_ACTION, false);
                synth.lockController(channel.number, midiControllers.bankSelect, false);
            }
            seq.loadNewSongList(parsedSongs); // the sequencer is already created, no need to create a new one.
        }
        seq.loop = false; // the sequencer loops a single song by default
        seq.preservePlaybackState = true;
        context.suspend();
        seq.pause();
        document.getElementById("pause-label").innerHTML = getPlaySvg(ICON_SIZE_PX);

        // make the slider move with the song and define what happens when the user moves the slider
        const slider = document.getElementById("progress");
        const currentTimeDisplay = document.getElementById('currentTime');
        const totalTimeDisplay = document.getElementById('totalTime');
        let timerID = setInterval(timerCallback, 500);
        slider.oninput = () => {
            currentTimeDisplay.textContent = formatTime(Number(slider.value));
        };
        slider.addEventListener("pointerdown", handleClickProgressSlider, true);
        slider.addEventListener("pointerup", handleReleaseProgressSlider, false);
        function handleClickProgressSlider() {
            clearInterval(timerID);
            timerID = null;
            console.log("progress slider clicked");
        }
        function handleReleaseProgressSlider() {
            seq.currentTime = Number(slider.value);
            timerID = setInterval(timerCallback, 500);
            if (document.getElementById("pause-label").innerHTML === getPauseSvg(ICON_SIZE_PX)) {
                context.resume();
                seq.play(); // resume
            }
            else {
                context.suspend();
                seq.pause(); // pause
            }
            console.log("progress slider released");
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

        playbackRateInput.addEventListener('input',playbackRateCallback);
        function playbackRateCallback() {
            seq.playbackRate = playbackRateInput.value;
            playbackRateValue.textContent = `${Number(playbackRateInput.value).toFixed(1)}x`;
            if (document.getElementById("pause-label").innerHTML === getPauseSvg(ICON_SIZE_PX)) {
                context.resume();
                seq.play(); // resume
            }
            else {
                context.suspend();
                seq.pause(); // pause
            }
            if (midiFileHash !== undefined && settings !== undefined) {
                settings.playbackRate = playbackRateInput.value;
                storeSettings(midiFileHash, settings);
            }
        }

        // on song change, show the name
        seq.addOnSongChangeEvent(e => {
            console.log("song changed");
            document.getElementById("message").innerText = e.midiName;
            context.suspend();
            seq.pause();
            document.getElementById("pause-label").innerHTML = getPlaySvg(ICON_SIZE_PX);

            //update progress slider
            slider.max = Math.floor(seq.duration);
            totalTimeDisplay.textContent = formatTime(seq.duration);
            
            // create channel controls
            const channelControlsContainer = document.getElementById('channel-controls');
            channelControlsContainer.innerHTML = ''; // Clear existing controls


            // read settings from cache if available
            generateHash(buffer)
            .then((data) => {
                midiFileHash = data;
                return retrieveSettings(midiFileHash);
            })
            .then ((data) => {
                settings = data;
                if (settings === null) { // no settings found in the cache
                    settings = {
                        playbackRate: 1.0,
                        channels: [],
                    };
                    let nrOfTracks = e.tracksAmount;
                    const channelsPerTrack = e.usedChannelsOnTrack;
                    const channelNumbers = new Set([...channelsPerTrack.flatMap(set => [...set])]); // unique channels in the midi file
                    const trackNames = getTrackNames(buffer); // track names in the midi file. Track contents is not available in e.
                    channelNumbers.forEach(channelNumber => {
                        const trackNumber = channelsPerTrack.findIndex(set => set.has(channelNumber));
                        const channelSettings = {
                            name: `${channelNumber}:${trackNames[trackNumber]}`,
                            number: channelNumber,
                            pan: Math.round((127*channelNumber)/(channelNumbers.size-1)), // automatically pans the channels from left to right range [0,127], 64 represents middle. This makes the channels more discernable., // Example default panning value (center)
                            volume: 85, // Example default volume value
                            selectedInstrument: "Default"
                        };
                        settings.channels.push(channelSettings);
                    });
                } 
                
                //set up playback rate control based on settings
                const playbackRateInput = document.getElementById('playbackRate');
                const playbackRateValue = document.getElementById('playbackRateValue');
                playbackRateInput.value = settings.playbackRate;
                seq.playbackRate = settings.playbackRate;
                playbackRateValue.textContent = `${Number(settings.playbackRate).toFixed(1)}x`;
                if (document.getElementById("pause-label").innerHTML === getPauseSvg(ICON_SIZE_PX)) {
                    context.resume();
                    seq.play(); // resume
                }
                else {
                    context.suspend();
                    seq.pause(); // pause
                }
                
                const instrumentControls = new Map(); // array of instrument controls to be able to control them
                for (const channel of settings.channels) {
                    const channelControl = createChannelControl(channel, synth, instrumentControls);
                    channelControlsContainer.appendChild(channelControl);
                }

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
            });
        
            const currentBank = new Map();
            synth.eventHandler.removeEvent("controllerchange","controller-change-event");
            synth.eventHandler.addEvent("controllerchange","controller-change-event", e => {
                if (e.controllerNumber === 0) { // bank select
                    console.log(`controller change to ${e.channel}:${e.controllerNumber}:${e.controllerValue}`);
                    currentBank.set(e.channel, e.controllerValue);
                }
            });
            
            function createChannelControl(channel, synth, instrumentControls) {
                const container = document.createElement('div');
                container.className = 'channel-control';
            
                const nameLabel = document.createElement('div');
                nameLabel.className = 'channel-name';
                nameLabel.innerText = channel.name;
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
                volumeSlider.onpointerup = () => {
                    channel.volume = parseInt(volumeSlider.value);
                    if (midiFileHash !== undefined && settings !== undefined) {
                        storeSettings(midiFileHash, settings);
                    }
                }
                container.appendChild(volumeSlider);
            
                const instrumentSelect = document.createElement('select');
                instrumentSelect.className = 'instrument-select'
                const option = document.createElement('option');
                option.className = 'instrument-option';
                option.value = ""
                option.textContent = "Default"
                if (channel.selectedInstrument === "Default") {
                    option.selected = true;
                } else {option.selected = false;}
                instrumentSelect.appendChild(option);
                
                if (channel.number === DEFAULT_PERCUSSION_CHANNEL) { synth.channelProperties[channel.number].isDrum = true; }
                if (!synth.channelProperties[channel.number].isDrum) { // do not have interactive drop-down menu when the channel is used for percussion.
                    let defaultInstrumentSelected = true;
                    for (const instrument of Object.values(instruments)) {
                        const option = document.createElement('option');
                        option.className = 'instrument-option';
                        option.value = `${instrument.bank}:${instrument.program}`;
                        option.textContent = instrument.presetName;
                        if (channel.selectedInstrument === instrument.presetName) {
                            option.selected = true;
                            defaultInstrumentSelected = false;
                        } else {option.selected = false;}
                        instrumentSelect.appendChild(option);
                    }
                    instrumentSelect.addEventListener('change', function(event) {
                        let data = event.target.value.split(":").map(value => parseInt(value, 10)); // bank:program
                        for (const option of event.target.options){
                            if (option.selected == true) {
                                channel.selectedInstrument = option.textContent;
                            }
                        }
                        synth.lockController(channel.number, midiControllers.bankSelect, false);
                        synth.controllerChange (channel.number, midiControllers.bankSelect, data[0]);
                        synth.lockController(channel.number, midiControllers.bankSelect, true);
                        currentBank.set(channel.number, data[0]);
                        synth.lockController(channel.number, ALL_CHANNELS_OR_DIFFERENT_ACTION, false);
                        synth.programChange(channel.number, data[1]);
                        synth.lockController(channel.number, ALL_CHANNELS_OR_DIFFERENT_ACTION, true);
                        console.log(`changing channel ${channel.number} to instrument ${event.target.value}`);
                        if (midiFileHash !== undefined && settings !== undefined) {
                            storeSettings(midiFileHash, settings);
                        }
                    });
                    instrumentControls.set(channel.number,instrumentSelect);
                    if (!defaultInstrumentSelected) {
                        setTimeout(() => {
                            const event = new Event("change");
                            instrumentSelect.dispatchEvent(event);
                            console.log(`activate instrument ${instrumentSelect.value} for channel ${channel.number}`);
                        }, 100); 
                    }                      
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
            if (document.getElementById("pause-label").innerHTML === getPlaySvg(ICON_SIZE_PX)) {
                document.getElementById("pause-label").innerHTML = getPauseSvg(ICON_SIZE_PX);
                context.resume();
                seq.play(); // resume
            }
            else {
                document.getElementById("pause-label").innerHTML = getPlaySvg(ICON_SIZE_PX);
                context.suspend();
                seq.pause(); // pause
            }
        }
    }

    let file = await retrieveSettings("current_midi_file");
    if (file) {
        setupApplication();
    }

    // add an event listener for the file input
    document.getElementById("midi_input").addEventListener("change", async event => {
        // check if any files are added
        file = event.target.files[0];
        if (!file) {
            return;
        }

        if (!(file.type === 'audio/midi' || file.type === 'audio/x-midi' || file.type === 'audio/mid')) { //incorrect file type
            document.getElementById("message").innerText = "Incorrect file type. Select a midi file.";
            return;
        }
        console.log("file opened");
        storeSettings("current_midi_file",file);
        setupApplication();
    });
});

function getTrackNames(arrayBuffer) { // returns the tracknames from the midifile represented in the arrayBuffer
    const parsedMIDI = new MIDI(arrayBuffer);
    const tracks = parsedMIDI.tracks; //array of tracks. Each track contains an array of midi messages (MidiMessages)
    const trackNames = [];
    for (const track of tracks) {
        const trackNameMessage = track.find(getTrackName);
        if (trackNameMessage === undefined) { // message not found in track
            trackNames.push("");
        } else {
            trackNames.push(getTrackName(trackNameMessage));
        }
    }
    return trackNames;
}

function getTrackName(element) {// element should be of type MidiMessage
    if (element.messageStatusByte === 0x03) { // track name message found
        const trackName = String.fromCharCode(...element.messageData);
        return trackName;
        }
    return "";
}






