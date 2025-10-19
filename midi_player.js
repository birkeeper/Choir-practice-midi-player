// import the modules

import { WORKLET_URL_ABSOLUTE, Sequencer, Synthetizer } from './libraries/spessasynth_lib/index.js';
import { midiControllers, ALL_CHANNELS_OR_DIFFERENT_ACTION, loadSoundFont, MIDI } from './libraries/spessasynth_core/index.js';
import { getPauseSvg, getPlaySvg, getFileOpenSvg, getFileHistorySvg } from './js/icons.js';
import { SOUNDFONT_GM, SOUNTFONT_SPECIAL } from "./constants.js";


const VERSION = "v2.0.0z"
const DEFAULT_PERCUSSION_CHANNEL = 9; // In GM channel 9 is used as a percussion channel
const ICON_SIZE_PX = 24; // size of button icons
const MAINVOLUME = 1.5;
const MAXNROFRECENTFILES = 1; // Maximum number of recently opened files that can be stored in the cache

let instruments; // map of midi instruments to secondary soundfont preset numbers
const SOUNDFONTBANK = 1; // bank where the secondary soundfont needs to be loaded

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
            registration.addEventListener("updatefound", () => {
                const installingWorker = registration.installing;
                console.log(`A new service worker is being installed: ${installingWorker}`);
                installingWorker.addEventListener("statechange", (e) => {
                    if(e.target.state === "installed") {
                        console.log("Service worker installed");
                        appendAlert(
                            `A new update of the app is available. When you dismiss this message or restart the app, the update is installed.`,
                            'warning', "update",
                            () => {
                                console.log("Posting skipWaiting to service worker.");
                                installingWorker.postMessage({ type: 'skipWaiting'}); }
                        );
                    }
                });
            });
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
        }
        else if (key.startsWith("blob_")) { // store file
            const fileURL = URL.createObjectURL(settings); // URL revoked in service worker
            postStoreSettingsMessage(key, fileURL);
        }
        else {
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

// Function to delete settings
async function deleteSettings(key, settings) {
    if (navigator.serviceWorker.controller) {
        console.log(`deleting settings (key: ${key}`);
        postDeleteSettingsMessage(key, settings);

        async function postDeleteSettingsMessage(key, settings) {
            navigator.serviceWorker.controller.postMessage({
                type: 'deleteFromCache',
                key: `./settings/${key}`,
                settings: settings
            });
        }
    }
}

// Function to retrieve settings
async function retrieveSettings(key) {
    try {
        if (navigator.serviceWorker.controller) {
            if (key === "all") { //retrieve all settings
                return new Promise((resolve, reject) => {
                    const messageChannel = new MessageChannel();
                
                    messageChannel.port1.onmessage = async (e) => {
                        const responseArray = e.data;
                        if (responseArray === null) {
                            resolve(null);
                        } else {
                            resolve(await Promise.all(responseArray));
                        }
                    };
                
                    navigator.serviceWorker.controller.postMessage({
                        type: "all",
                        key: undefined,
                        settings: undefined
                    }, [messageChannel.port2,]);
                });          
            } else {
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
                } else if (key.startsWith("blob_")){
                    if (response1.ok) {
                        const fileBlob = await response1.blob();
                        const file = new File([fileBlob], key, {type: `${fileBlob.type}`});
                        URL.revokeObjectURL(response1.url);
                        return file;
                    } 
                } else {
                    if (response1.ok) {
                        return await response1.json();
                    }
                }
            }
        }
    } catch(error){
        console.error(error);
    }
    return Promise.resolve(null);
}

async function deleteFromCache(key) {
    if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
            type: 'deleteFromCache',
            key: key
        });
    }
}

const alertPlaceholder = document.getElementById('alertPlaceholder');
const appendAlert = (message, type, id, callback) => {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = [
    `<div id=${id} class="alert alert-${type} alert-dismissible" role="alert">`,
    `   <div>${message}</div>`,
    '   <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>',
    '</div>'
  ].join('');
  alertPlaceholder.append(wrapper);
  if (callback !== undefined) {
    const alert = document.getElementById(id);
    alert.addEventListener('closed.bs.alert', (event) => { callback(event);  });
  }
}

document.getElementById('version').textContent = VERSION;
document.getElementById("pause-label").innerHTML = getPlaySvg(ICON_SIZE_PX);
document.getElementById("midi_input-label").innerHTML = getFileOpenSvg(ICON_SIZE_PX);
document.getElementById("history-label").innerHTML = getFileHistorySvg(ICON_SIZE_PX);


{
    // load the soundfonts
    const [responseSecondary, responsePrimary] = await Promise.all([fetch(SOUNTFONT_SPECIAL), fetch(SOUNDFONT_GM)]);
    // load the soundfonts into array buffers
    const [secondarySoundFontBuffer, primarySoundFontBuffer] = await Promise.all([responseSecondary.arrayBuffer(), responsePrimary.arrayBuffer()]);
    
    // create the context and add audio worklet
    const context = new AudioContext({latencyHint: "playback"});
    await context.audioWorklet.addModule(new URL("./libraries/spessasynth_lib/" + WORKLET_URL_ABSOLUTE, import.meta.url));
    const synth = new Synthetizer(context.destination, primarySoundFontBuffer, undefined, undefined, {chorusEnabled: false, reverbEnabled: false});     // create the synthetizer
    {
        const soundFont = loadSoundFont(secondarySoundFontBuffer);
        instruments = {...soundFont.presets};
    }
    document.getElementById("message").innerText = "Select a midi file.";
    for (const instrument of Object.values(instruments)) { //adjust soundfont presets to new bank
        instrument.bank = SOUNDFONTBANK;
    }
    await synth.isReady;
    await synth.soundfontManager.addNewSoundFont(secondarySoundFontBuffer,"secondary",SOUNDFONTBANK);
    document.getElementById("midi_input").disabled = false;
    synth.setMainVolume(MAINVOLUME);

    let seq;
    let settings;
    let timerID;
    
    async function setupApplication() {
        // parse all the files
        const parsedSongs = [];
        const buffer = await file.arrayBuffer();
        const midiFileHash = await generateHash(buffer);
        parsedSongs.push({
            binary: buffer,     // binary: the binary data of the file
            altName: file.name  // altName: the fallback name if the MIDI doesn't have one. Here we set it to the file name
        });
        
        const slider = document.getElementById("progress");
        const totalTimeDisplay = document.getElementById('totalTime');
        const playbackRateInput = document.getElementById('playbackRate');
        const playbackRateValue = document.getElementById('playbackRateValue');

        function formatTime(seconds) {// for displaying song progress
            const minutes = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        }

        if(seq === undefined)
        { // setup main part of the application. This is only executed once after startup when the first song is loaded.
            seq = new Sequencer(parsedSongs, synth, {skipToFirstNoteOn: false,}); // create the sequencer with the parsed midis
            
            // make the slider move with the song and define what happens when the user moves the slider
            const currentTimeDisplay = document.getElementById('currentTime');
            if (timerID) {
                clearInterval(timerID);
                console.log(`progress slider timer cleared: ${timerID}`);
            }
            timerID = setInterval(timerCallback, 500);
            console.log(`progress slider timer started: ${timerID}`);
            slider.oninput = () => {
                currentTimeDisplay.textContent = formatTime(Number(slider.value));
            };
            slider.addEventListener("pointerdown", handleClickProgressSlider, { capture: true});
            slider.addEventListener("pointerup", handleReleaseProgressSlider, { capture: false});
            slider.addEventListener("touchend", handleReleaseProgressSlider, { capture: false}); // else it won't work on touch devices when dragging the slider
        
            function handleClickProgressSlider() {
                if (timerID) {
                    clearInterval(timerID);
                    console.log(`progress slider timer cleared: ${timerID}`);
                    timerID = undefined;
                }
                console.log("progress slider clicked");
            }
        
            function handleReleaseProgressSlider() {
                seq.currentTime = Number(slider.value);
                if (!timerID) {
                    timerID = setInterval(timerCallback, 500);
                    console.log(`progress slider timer started: ${timerID}`);

                    if (document.getElementById("pause-label").innerHTML === getPauseSvg(ICON_SIZE_PX)) {
                        context.resume();
                        seq.play(); // resume
                    }
                    else {
                        context.suspend();
                        seq.pause(); // pause
                    }
                }         
                console.log("progress slider released");
            }

            function timerCallback() {
                slider.value = Math.floor(seq.currentTime);
                currentTimeDisplay.textContent = formatTime(seq.currentTime);            
            }

            // make a slider to set the playback rate
            playbackRateInput.addEventListener('input',playbackRateCallback);
            function playbackRateCallback() {
                seq.playbackRate = playbackRateInput.value;
                playbackRateValue.textContent = `${Number(playbackRateInput.value).toFixed(2)}x`;
                if (document.getElementById("pause-label").innerHTML === getPauseSvg(ICON_SIZE_PX)) {
                    context.resume();
                    seq.play(); // resume
                }
                else {
                    context.suspend();
                    seq.pause(); // pause
                }
                if (settings?.midiFileHash !== undefined) {
                    settings.playbackRate = playbackRateInput.value;
                    storeSettings(settings.midiFileHash, settings);
                }
            }
        }
        else { //when seq is defined
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

        // on song change, show the name
        seq.addOnSongChangeEvent(e => {
            console.log("song changed");
            context.suspend();
            seq.pause();
            document.getElementById("pause-label").innerHTML = getPlaySvg(ICON_SIZE_PX);

            //update progress slider
            slider.max = Math.floor(seq.duration);
            totalTimeDisplay.textContent = formatTime(seq.duration);
            
            // create channel controls
            const channelControlsContainer = document.getElementById('channel-controls');
            const channelControlHeader = document.getElementById('channel-control-header');
            channelControlsContainer.innerHTML = channelControlHeader.outerHTML; // Clear existing controls except for the header

            // read settings from cache if available
            retrieveSettings(midiFileHash)
            .then ((data) => {
                settings = data;
                if (settings === null) { // no settings found in the cache
                    settings = {
                        midiFileHash: midiFileHash,
                        midiName: e.midiName,
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
                if (!Object.hasOwn(settings,"midiFileHash")) { //ensure compatibility with old settings stored in cache
                    settings.midiFileHash = midiFileHash;
                    settings.midiName = e.midiName;
                }
                settings.lastOpened = Date.now();
                storeSettings(settings.midiFileHash,settings);
                document.getElementById("message").innerText = settings.midiName;
                
                //set up playback rate control based on settings
                playbackRateInput.value = settings.playbackRate;
                seq.playbackRate = settings.playbackRate;
                playbackRateValue.textContent = `${Number(settings.playbackRate).toFixed(2)}x`;
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
                    const channelControl = createChannelControl(channel, synth, instrumentControls, channel === settings.channels[settings.channels.length-1]);
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
            
            function createChannelControl(channel, synth, instrumentControls, lastChannel) {
                const container = document.createElement('div');
                if (lastChannel){container.className = 'd-flex flex-row align-items-center mt-2 mb-2 w-100';} // added bottom margin
                else {container.className = 'd-flex flex-row align-items-center mt-2 w-100';}
                            
                const nameLabel = document.createElement('div');
                nameLabel.className = 'd-flex ms-2 channel-name';
                nameLabel.innerText = channel.name;
                container.appendChild(nameLabel);
                
                const volumeSlider = document.createElement('input');
                volumeSlider.type = 'range';
                volumeSlider.className = 'form-range flex-grow-0 flex-shrink-1 ms-2 volume-control';
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
                    channel.volume = parseInt(volumeSlider.value);
                    if (settings?.midiFileHash !== undefined) {
                        storeSettings(settings.midiFileHash, settings);
                    }
                }
            
                const column2 = document.createElement('div');
                column2.className = 'd-flex volume-control ms-2 flex-grow-0 flex-shrink-1';
                column2.appendChild(volumeSlider);
                container.appendChild(column2);
                
                const instrumentSelect = document.createElement('select');
                instrumentSelect.className = 'form-select';
                const option = document.createElement('option');
                //option.className = 'instrument-option';
                option.value = ""
                option.textContent = "Default"
                if (channel.selectedInstrument === "Default") {
                    option.selected = true;
                } else {option.selected = false;}
                instrumentSelect.appendChild(option);
                
                if (channel.number === DEFAULT_PERCUSSION_CHANNEL) { 
                    synth.channelProperties[channel.number].isDrum = true; 
                    instrumentSelect.disabled = true;
                }
                if (!synth.channelProperties[channel.number].isDrum) { // do not have interactive drop-down menu when the channel is used for percussion.
                    let defaultInstrumentSelected = true;
                    for (const instrument of Object.values(instruments)) {
                        const option = document.createElement('option');
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
                        if (settings?.midiFileHash !== undefined) {
                            storeSettings(settings.midiFileHash, settings);
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
                const column = document.createElement('div');
                column.className = 'd-flex instrument-select mx-2';
                column.appendChild(instrumentSelect);
                container.appendChild(column);

                            
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

        if (!(file.type === 'audio/midi' || file.type === 'audio/x-midi' || file.type === 'audio/mid' || file.type === 'audio/midi-clip' 
            || file.type === 'audio/rtp-midi' || file.type === 'audio/rtx' || file.type === 'audio/sp-midi')) { //incorrect file type
            appendAlert( "Incorrect file type. Select a midi file.", 'warning', 'fileError');
            return;
        }
        console.log("file opened");
        const midiFileHash = await generateHash(await file.arrayBuffer());
        storeSettings("current_midi_file",file);
        storeSettings(`blob_${midiFileHash}`,file);
        setupApplication();
    });

    // add an event listener for the recently opened files
    const history = document.getElementById("history");
    history.addEventListener("click", async event => {
        console.log("retrieving recently opened files");
        const historyList = await retrieveSettings('all');
        console.log(historyList);
        const historyDropdown = document.getElementById("historyDropdown");
        historyDropdown.innerHTML = `<li><h5 class="dropdown-header">Recently opened songs</h5></li>\n`;
        if (!Array.isArray(historyList)) { return; }
        historyList.sort((a,b) => { // sort list by date, last opened first
            if (!Object.hasOwn(a, "lastOpened")) {return 1;}
            if (!Object.hasOwn(b, "lastOpened")) {return -1;}
            if (a.lastOpened > b.lastOpened) {return -1;}
            else { return 1;}
        });
        historyList.forEach( async (item, index) => {
            if (index >= MAXNROFRECENTFILES) { 
                console.log(`More than ${MAXNROFRECENTFILES} songs stored in cash. Removing ${li.midiFileHash} from cache.`)
                deleteSettings(`blob_${li.midiFileHash}`);
                deleteSettings(`${li.midiFileHash}`);
                return; 
            }
            
            const li = document.createElement('li');
            li.innerHTML = `<a class="dropdown-item">${item.midiName}</a>`;
            li.midiFileHash = `${item.midiFileHash}`;
            li.onclick = async (event) => {
                const clickedElement = event.target;
                const li = clickedElement.closest('li');
                console.log(`midihash: ${li.midiFileHash}`);
                file = await retrieveSettings(`blob_${li.midiFileHash}`);
                if (file === null) { // file blob not found in cache
                    console.log(`blob_${li.midiFileHash} not found in cash`);
                    deleteSettings(`${li.midiFileHash}`);
                    appendAlert( "File not found. Select a different file or open a new one.", 'warning', 'fileError');
                } else {
                    console.log(`blob_${li.midiFileHash} retrieved from cash`);
                    storeSettings("current_midi_file", file);
                    setupApplication();
                }
            };
            historyDropdown.appendChild(li);
        });
    });
}

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






