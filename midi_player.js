// import the modules
import { MIDI } from './libraries/spessasynth_core/index.js';
import { getPauseSvg, getPlaySvg, getFileOpenSvg, getFileHistorySvg, getForwardSvg, getBackwardSvg } from './js/icons.js';
import { WAV_NROFCHANNELS, WAV_BITSPERSAMPLE, WAV_SAMPLERATE, WAV_HEADERSIZE } from "./constants.js";

const VERSION = "v2.0.1db"
const DEFAULT_PERCUSSION_CHANNEL = 9; // In GM channel 9 is used as a percussion channel
const ICON_SIZE_PX = 24; // size of button icons
const MAXNROFRECENTFILES = 10; // Maximum number of recently opened files that can be stored in the cache
const SKIPFORWARD_SECONDS = 10; // skip audio forwards in seconds
const SKIPBACKWARD_SECONDS = 10; // skip audio backwards in seconds


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
								appendAlert("Update installing... When the installation has finished, the app will be reloaded automatically",'warning', "update");
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

const dedicatedWorker = new Worker('./dedicated-worker.js', {type: "module"});
dedicatedWorker.onerror = e => console.error("WORKER ERROR:", e.message, e);
dedicatedWorker.onmessageerror = e => console.error("WORKER MESSAGE ERROR:", e);

console.log("dedicated worker created");
navigator.serviceWorker.addEventListener("message", (event) => {
    const { data, ports } = event;
    const portFromSW = ports && ports[0];
    if (!data) return;
	if (data.type === 'AUDIO_RANGE_REQ') {
		if (!portFromSW) return;
		console.log(`received ${data.type} message in main.js`);
		dedicatedWorker.postMessage(data, [portFromSW]);
	}
	else if (data.type === 'DEBUG') {
		appendAlert(data.message,'info', 'debug');
	}
});

// Function to store settings
async function storeSettings(key, settings) {
    if (navigator.serviceWorker.controller) {
		return new Promise((resolve, reject) => {
			const messageChannel = new MessageChannel();
			messageChannel.port1.onmessage = async (e) => {
				console.log(`main: ${e.data}`);
				resolve();
			}
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
			function postStoreSettingsMessage(key, settings) {
				navigator.serviceWorker.controller.postMessage({
					type: 'storeSettings',
					key: `./settings/${key}`,
					settings: settings
				}, [messageChannel.port2,]);
			}
		});
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
						messageChannel.port1.close();
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
document.getElementById("forward-label").innerHTML = getForwardSvg(ICON_SIZE_PX);
document.getElementById("backward-label").innerHTML = getBackwardSvg(ICON_SIZE_PX);

const audioElement = new Audio();
audioElement.addEventListener("error",(event) => {
	console.log(`main: error event on AudioElement: ${audioElement.error.code}, ${audioElement.error.message}, ${audioElement.src}`);
});
audioElement.addEventListener("stalled", (event) => {
	console.log(`main: AudioElement stalled. Ready state: ${audioElement.readyState}, ${audioElement.src}`);
});
audioElement.addEventListener("suspend", (event) => {
	console.log(`main: AudioElement suspended. Ready state: ${audioElement.readyState}, ${audioElement.src}`);
});
audioElement.addEventListener("ended", (event) => {
	console.log(`main: playing of source AudioElement ended. Ready state: ${audioElement.readyState}, ${audioElement.src}`);
});
console.log("audioElement created");

dedicatedWorker.onmessage = (e) => {
	const msg = e.data;
	if (msg.type === 'workerInitalised')
	{
		console.log("dedicated worker initialised")
		activateApplication(msg.instruments);
	}
	else if (msg.type === 'DEBUG') {
		appendAlert(msg.message,'info', 'debug');
	}
};
console.log("dedicate worker's onmessage defined");

async function activateApplication(instruments) 
{
    document.getElementById("midi_input").disabled = false;
	document.getElementById("message").innerText = "open midi file";

    let settings;
    
    async function setupApplication() {
        // parse all the files
        const parsedSongs = [];
        const buffer = await file.arrayBuffer();
        const midiFileHash = await generateHash(buffer);
		const midi = new MIDI(buffer, file.name);
        dedicatedWorker.postMessage({type: 'LOAD_MIDI', midi: midi});
        
        const progressSlider = document.getElementById("progress");
		progressSlider.BeingDragged = false;
        const totalTimeDisplay = document.getElementById('totalTime');
        const playbackRateInput = document.getElementById('playbackRate');
        const playbackRateValue = document.getElementById('playbackRateValue');
        const currentTimeDisplay = document.getElementById('currentTime');

        function formatTime(seconds) {// for displaying song progress
            const minutes = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        }

		// make the slider move with the song and define what happens when the user moves the slider
		progressSlider.oninput = () => {
			currentTimeDisplay.textContent = formatTime(Number(progressSlider.value));
		};
		progressSlider.addEventListener("pointerdown", handleClickProgressSlider, { capture: true});
		progressSlider.addEventListener("pointerup", handleReleaseProgressSlider, { capture: false});
		progressSlider.addEventListener("touchstart", handleClickProgressSlider, { capture: true}); // else it won't work on touch devices when dragging the slider
		progressSlider.addEventListener("touchcancel", handleReleaseProgressSlider, { capture: false}); // else it won't work on touch devices when dragging the slider
		progressSlider.addEventListener("touchend", handleReleaseProgressSlider, { capture: false}); // else it won't work on touch devices when dragging the slider
		
		function handleClickProgressSlider() {
			progressSlider.BeingDragged = true;
			console.log("progress slider clicked");
		}
	
		function handleReleaseProgressSlider() {
			audioElement.currentTime = Number(progressSlider.value) / settings.playbackRate;
			progressSlider.BeingDragged = false;
			console.log("progress slider released");
		}

		audioElement.addEventListener("timeupdate", () => { 
			if (!progressSlider.BeingDragged) {
				progressSlider.value = Math.floor(audioElement.currentTime * settings.playbackRate);
				currentTimeDisplay.textContent = formatTime(audioElement.currentTime * settings.playbackRate);    
				if (("mediaSession" in navigator) && (audioElement.duration >= audioElement.currentTime)) {
					navigator.mediaSession.setPositionState({duration: audioElement.duration * settings.playbackRate, position: audioElement.currentTime * settings.playbackRate});
				} 
			}
		});

		// make a slider to set the playback rate
		playbackRateInput.addEventListener('change',playbackRateCallback);
		async function playbackRateCallback() {
			playbackRateValue.textContent = `${Number(playbackRateInput.value).toFixed(2)}x`;
			dedicatedWorker.postMessage({type: 'playbackRate', value: playbackRateInput.value});
			let currentPlaybackRate = settings.playbackRate;
			if (settings?.midiFileHash !== undefined) {
				settings.playbackRate = playbackRateInput.value;
				settings.wavLength_bytes = Math.floor(settings.duration_s / settings.playbackRate * WAV_SAMPLERATE * (WAV_BITSPERSAMPLE/8) * WAV_NROFCHANNELS) + WAV_HEADERSIZE; // [bytes] length of wave file
				await storeSettings(settings.midiFileHash, settings);
			}
			updateAudioElement(currentPlaybackRate);
		}
        
        // on song ended reset the current time and pause the song
		audioElement.onended = () => {
            document.getElementById("pause-label").innerHTML = getPlaySvg(ICON_SIZE_PX);
            audioElement.pause();
            audioElement.currentTime = 0.0;
            progressSlider.value = Math.floor(0.0);
            currentTimeDisplay.textContent = formatTime(0.0);
            if ("mediaSession" in navigator) {
                navigator.mediaSession.playbackState = "paused";
                navigator.mediaSession.setPositionState({duration: audioElement.duration*settings.playbackRate, position: 0.0});
            }
        }
        
        // on song change, show the name
        {
            console.log("song changed");
            document.getElementById("pause-label").innerHTML = getPlaySvg(ICON_SIZE_PX);

            //update progress slider
            progressSlider.max = Math.floor(midi.duration);
            totalTimeDisplay.textContent = formatTime(midi.duration);
            
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
                        midiName: midi.midiName,
                        playbackRate: 1.0,
                        channels: [],
                    };
                    let nrOfTracks = midi.tracksAmount;
                    const channelsPerTrack = midi.usedChannelsOnTrack;
                    const channelNumbers = new Set([...channelsPerTrack.flatMap(set => [...set])]); // unique channels in the midi file
                    const trackNames = getTrackNames(midi); // track names in the midi file.
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
                    settings.midiName = midi.midiName;
                }
				if (!Object.hasOwn(settings,"wavLength_bytes")) { //ensure compatibility with old settings stored in cache
					settings.duration_s = midi.duration; // [s] midi duration. start of the file to `midi.lastVoiceEventTick`.
					settings.wavLength_bytes = Math.floor(midi.duration / settings.playbackRate * WAV_SAMPLERATE * (WAV_BITSPERSAMPLE/8) * WAV_NROFCHANNELS) + WAV_HEADERSIZE; // [bytes] length of wave file
				}
                settings.lastOpened = Date.now();
				document.getElementById("message").innerText = settings.midiName;
                document.getElementById("pause-label").innerHTML = getPlaySvg(ICON_SIZE_PX);
                               
                //set up playback rate control based on settings
                playbackRateInput.value = settings.playbackRate;
                dedicatedWorker.postMessage({type: 'playbackRate', value: settings.playbackRate});
                playbackRateValue.textContent = `${Number(settings.playbackRate).toFixed(2)}x`;

                const instrumentControls = new Map(); // array of instrument controls to be able to control them
                for (const channel of settings.channels) {
                    const channelControl = createChannelControl(channel, instrumentControls, channel === settings.channels[settings.channels.length-1]);
                    channelControlsContainer.appendChild(channelControl);
                }
				
				storeSettings(settings.midiFileHash,settings)
				.then( () => { // setup audioElement
                	audioElement.src = `./generatedWav/${settings.midiFileHash}_${self.crypto.randomUUID()}.wav`; // point to file that will be generated on the fly
					console.log(`generated wave file loaded: ${audioElement.src}`);
					audioElement.pause();
					audioElement.currentTime = 0.0;
					progressSlider.value = Math.floor(0.0);
					currentTimeDisplay.textContent = formatTime(0.0);
					if ("mediaSession" in navigator) {
						navigator.mediaSession.metadata = new MediaMetadata({title: `${settings.midiName}`});
						navigator.mediaSession.playbackState = "paused";
						navigator.mediaSession.setPositionState({duration: settings.duration_s, position: 0.0});
						navigator.mediaSession.setActionHandler("pause", () => {
                            document.getElementById("pause-label").innerHTML = getPlaySvg(ICON_SIZE_PX);
                            audioElement.pause();
                            navigator.mediaSession.playbackState = "paused";
                        });
                        navigator.mediaSession.setActionHandler("play", () => {
                            document.getElementById("pause-label").innerHTML = getPauseSvg(ICON_SIZE_PX);
                            audioElement.play();
                            navigator.mediaSession.playbackState = "playing";
                        });
                        navigator.mediaSession.setActionHandler("seekto", (evt) => {
                            if(!evt?.fastSeek)
                            {
                                progressSlider.BeingDragged = false;
								audioElement.currentTime = evt.seekTime / settings.playbackRate;
                                progressSlider.value = Math.floor(evt.seekTime);
                                currentTimeDisplay.textContent = formatTime(evt.seekTime);
                            }
							else {
								progressSlider.BeingDragged = true;
							}
                        });
						navigator.mediaSession.setActionHandler("nexttrack", () => {
                            audioElement.currentTime = Math.min((audioElement.currentTime*settings.playbackRate + SKIPFORWARD_SECONDS)/settings.playbackRate, audioElement.duration-1);
                        });
						navigator.mediaSession.setActionHandler("previoustrack", () => {
                            audioElement.currentTime = Math.max((audioElement.currentTime*settings.playbackRate - SKIPBACKWARD_SECONDS)/settings.playbackRate, 0);
                        });
					}
				});
            });

            
            function createChannelControl(channel, instrumentControls, lastChannel) {
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
				dedicatedWorker.postMessage({type: 'SetMainVolume', channel: channel.number, value: volumeSlider.value});
                volumeSlider.onchange = async () => {
                    dedicatedWorker.postMessage({type: 'SetMainVolume', channel: channel.number, value: volumeSlider.value});
                    channel.volume = parseInt(volumeSlider.value);
                    if (settings?.midiFileHash !== undefined) {
                        await storeSettings(settings.midiFileHash, settings);
                    }
					updateAudioElement(settings.playbackRate);					
                }
            
                const column2 = document.createElement('div');
                column2.className = 'd-flex volume-control ms-2 flex-grow-0 flex-shrink-1';
                column2.appendChild(volumeSlider);
                container.appendChild(column2);
                
                const instrumentSelect = document.createElement('select');
                instrumentSelect.className = 'form-select';
                const option = document.createElement('option');
                //option.className = 'instrument-option';
                option.value = "-1:0"
                option.textContent = "Default"
                if (channel.selectedInstrument === "Default") {
                    option.selected = true;
					dedicatedWorker.postMessage({type: 'releaseBankSelect', channel: channel.number}); // bankselect controller is released
					dedicatedWorker.postMessage({type: 'releasePreset', channel: channel.number}); // preset is released
                } else {option.selected = false;}
                instrumentSelect.appendChild(option);
                
                if (channel.number === DEFAULT_PERCUSSION_CHANNEL) { 
                    dedicatedWorker.postMessage({type: 'isDrum', channel: channel.number, boolean: true});
					instrumentSelect.disabled = true;
                }
                else { // do not have interactive drop-down menu when the channel is used for percussion.
                    for (const instrument of Object.values(instruments)) {
                        const option = document.createElement('option');
                        option.value = `${instrument.bank}:${instrument.program}`;
                        option.textContent = instrument.presetName;
                        if (channel.selectedInstrument === instrument.presetName) { // activate selected instrument
                            option.selected = true;
							dedicatedWorker.postMessage({type: 'bankSelect', channel: channel.number, value: instrument.bank});
							dedicatedWorker.postMessage({type: 'programChange', channel: channel.number, value: instrument.program});
                        } else {option.selected = false;}
                        instrumentSelect.appendChild(option);
                    }
                    instrumentSelect.addEventListener('change', async function(event) {
                        let data = event.target.value.split(":").map(value => parseInt(value, 10)); // bank:program
                        for (const option of event.target.options){
                            if (option.selected == true) {
                                channel.selectedInstrument = option.textContent;
                            }
                        }
                        if (data[0] === -1) { // default instrument selected
							dedicatedWorker.postMessage({type: 'releaseBankSelect', channel: channel.number}); // bankselect controller is released
							dedicatedWorker.postMessage({type: 'releasePreset', channel: channel.number}); // preset is released
						} else {
							dedicatedWorker.postMessage({type: 'bankSelect', channel: channel.number, value:  data[0]});
							dedicatedWorker.postMessage({type: 'programChange', channel: channel.number, value:  data[1]});
						}
                        //currentBank.set(channel.number, data[0]);
						console.log(`changing channel ${channel.number} to instrument ${event.target.value}`);
                        if (settings?.midiFileHash !== undefined) {
                            await storeSettings(settings.midiFileHash, settings);
                        }
						updateAudioElement(settings.playbackRate);
                    });
                    instrumentControls.set(channel.number,instrumentSelect);                 
                }
                const column = document.createElement('div');
                column.className = 'd-flex instrument-select mx-2';
                column.appendChild(instrumentSelect);
                container.appendChild(column);

                            
                //set and lock modulation wheel, because it seems to be used a lot and creates a kind of vibrato, that is not pleasant
                dedicatedWorker.postMessage({type: 'modulationWheel', channel: channel.number, value: 0});
            
                //set and lock the pan of the channel
				dedicatedWorker.postMessage({type: 'pan', channel: channel.number, value: channel.pan});            
                return container;
            }
        }

        // on pause click
        document.getElementById("pause").onclick = () => {
            if (document.getElementById("pause-label").innerHTML === getPlaySvg(ICON_SIZE_PX)) {
                document.getElementById("pause-label").innerHTML = getPauseSvg(ICON_SIZE_PX);
				audioElement.play();
                if ("mediaSession" in navigator) {
 					navigator.mediaSession.setPositionState({duration: audioElement.duration*settings.playbackRate, position: audioElement.currentTime*settings.playbackRate});
                    navigator.mediaSession.playbackState = "playing";
                }
            }
            else {
                document.getElementById("pause-label").innerHTML = getPlaySvg(ICON_SIZE_PX);
                audioElement.pause();
                if ("mediaSession" in navigator) {
					navigator.mediaSession.playbackState = "paused";
					navigator.mediaSession.setPositionState({duration: audioElement.duration*settings.playbackRate, position: audioElement.currentTime*settings.playbackRate});
                }
            }
        }

		// on forward click
        document.getElementById("forward").onclick = () => {
			audioElement.currentTime = Math.min((audioElement.currentTime*settings.playbackRate + SKIPFORWARD_SECONDS)/settings.playbackRate, audioElement.duration-1);
        }

		// on backward click
        document.getElementById("backward").onclick = () => {
			audioElement.currentTime = Math.max((audioElement.currentTime*settings.playbackRate - SKIPBACKWARD_SECONDS)/settings.playbackRate, 0);
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

	function updateAudioElement(currentPlaybackRate) { // 
		const currentTime = audioElement.currentTime * currentPlaybackRate;
		const paused = audioElement.paused; 
		audioElement.src = `./generatedWav/${settings.midiFileHash}_${self.crypto.randomUUID()}.wav`;
		audioElement.load();
		audioElement.currentTime = currentTime / settings.playbackRate;
		if (paused) { audioElement.pause(); }
		else { audioElement.play();}
	}

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
                console.log(`More than ${MAXNROFRECENTFILES} songs stored in cash. Removing ${item.midiFileHash} from cache.`)
                deleteSettings(`blob_${item.midiFileHash}`);
                deleteSettings(`${item.midiFileHash}`);
                return; 
            }
            
            if (!Object.hasOwn(item, "lastOpened")) {return;} //unlikely to have a blob stored in the cache, because it has been copied from a previous cache.

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

function getTrackNames(parsedMIDI) { // returns the tracknames from the midifile represented in the arrayBuffer
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






